import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { projectExecutionDiagnostics, projectThrownOperationDiagnostic } from '../../src/tui/diagnostic-projection.js';
import { OperationHistoryStore, type OperationHistoryRecord } from '../../src/tui/operation-history.js';
import { readSafeOperationError } from '../../src/utils/safe-operation-diagnostic.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.remove(directory)));
});

function record(index: number, detailLines: string[] = []): OperationHistoryRecord {
  const effects = {
    configCommit: 'notApplicable' as const,
    awWrite: 'notStarted' as const,
    preApplyExternalEffect: 'notApplicable' as const,
    finalVerification: 'notStarted' as const,
  };
  return {
    summary: {
      recordId: `1:operation-${index}`,
      epoch: 1,
      operationId: `operation-${index}`,
      createdAtMs: index,
      state: 'blocked',
      code: 'operationFailed',
      message: 'The operation did not complete.',
      diagnosticCount: 1,
      effects,
    },
    diagnostics: [{
      id: `diagnostic-${index}`,
      code: 'operationFailed',
      safeMessage: 'The operation did not complete.',
      causes: [],
      detailLines,
    }],
    targets: [],
  };
}

describe('TUI operation history', () => {
  it('keeps only twenty safe records and binds identity to the session epoch', () => {
    const history = new OperationHistoryStore();
    for (let index = 0; index < 22; index += 1) history.record(record(index));

    expect(history.list()).toHaveLength(20);
    expect(history.list()[0]?.recordId).toBe('1:operation-21');
    expect(history.get('1:operation-0')).toBeUndefined();
  });

  it('bounds diagnostic detail and marks the report as omitted', () => {
    const history = new OperationHistoryStore();
    history.record(record(1, Array.from({ length: 1_005 }, (_, index) => `safe line ${index}`)));

    const detail = history.get('1:operation-1')!;
    expect(detail.diagnostics[0]?.detailLines).toHaveLength(1_000);
    expect(detail.diagnostics[0]?.omitted).toEqual({ reason: 'limit', count: 5 });
    expect(history.preview('1:operation-1')).toMatchObject({ omitted: true });
  });

  it('also bounds diagnostic detail by encoded byte size', () => {
    const history = new OperationHistoryStore();
    history.record(record(1, Array.from({ length: 900 }, () => 'x'.repeat(300))));

    const diagnostic = history.get('1:operation-1')!.diagnostics[0]!;
    expect(Buffer.byteLength(`${diagnostic.detailLines.join('\n')}\n`)).toBeLessThanOrEqual(256 * 1024);
    expect(diagnostic.omitted).toMatchObject({ reason: 'limit' });
  });

  it('defensively redacts typed metadata and selects only its explicit fields', () => {
    const secret = 'q7';
    const error = Object.assign(new Error('raw'), {
      operationDiagnostic: {
        code: 'nativeCliFailed',
        stage: 'native.write',
        safeMessage: `fixed ${secret} /Users/private/file`,
        exitCode: 3,
        cause: { code: 'EACCES', safeMessage: `cause ${secret}`, raw: 'do-not-copy' },
        raw: 'do-not-copy',
      },
    });

    expect(readSafeOperationError(error)).toEqual({
      code: 'nativeCliFailed',
      stage: 'native.write',
      safeMessage: `fixed ${secret} /Users/private/file`,
      exitCode: 3,
      cause: { code: 'EACCES', safeMessage: `cause ${secret}` },
    });
    const diagnostic = projectThrownOperationDiagnostic({
      error, id: '1:test', stage: 'execute', fallbackCode: 'operationFailed', sensitiveValues: [secret],
    });
    expect(JSON.stringify(diagnostic)).not.toContain(secret);
    expect(JSON.stringify(diagnostic)).not.toContain('/Users/private');

    const history = new OperationHistoryStore();
    const unsafe = record(1, [`detail ${secret}`]);
    unsafe.summary.message = `summary ${secret} /Users/private/file`;
    unsafe.diagnostics[0] = { ...unsafe.diagnostics[0]!, safeMessage: `message ${secret}` };
    history.record(unsafe, { sensitiveValues: [secret] });
    expect(JSON.stringify(history.get('1:operation-1'))).not.toContain(secret);
    expect(JSON.stringify(history.get('1:operation-1'))).not.toContain('/Users/private');
  });

  it('previews before an exclusive local save and does not replace an existing file', async () => {
    const history = new OperationHistoryStore();
    history.record(record(1));
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-tui-report-test-'));
    temporaryDirectories.push(directory);
    const target = path.join(directory, 'report.md');
    const preview = history.preview('1:operation-1')!;

    await expect(history.save('1:operation-1', target)).resolves.toEqual({ path: target });
    await expect(fs.readFile(target, 'utf8')).resolves.toBe(preview.content);
    await expect(history.save('1:operation-1', target)).rejects.toMatchObject({ code: 'EEXIST' });
  });
});

describe('TUI operation diagnostic projection', () => {
  it('keeps safe blocked target diagnostic fields without copying private values', () => {
    const projected = projectExecutionDiagnostics({
      taskPlan: {
        blockedTargets: [{
          target: { pluginId: 'official/demo', platform: 'codex', scope: 'user' },
          diagnostics: [{
            id: 'temporary', code: 'preApplyExited', stage: 'preApply', sourceId: 'official',
            safeMessage: 'The preApply process exited unsuccessfully.', exitCode: 9,
            causes: [{ code: 'EACCES', safeMessage: 'Access denied for private-token.' }],
            detailLines: ['Recovery: retry without private-token.'],
          }],
        }],
      },
    }, 'blocked-task', ['private-token'], 'pluginWriteTask');

    expect(projected.diagnostics).toEqual([expect.objectContaining({
      code: 'preApplyExited', stage: 'preApply', sourceId: 'official', exitCode: 9,
      causes: [{ code: 'EACCES', safeMessage: expect.not.stringContaining('private-token') }],
      detailLines: [expect.not.stringContaining('private-token')],
    })]);
  });

  it('keeps typed preApply facts without copying raw output', () => {
    const secret = 'stderr: token=private-value';
    const projected = projectExecutionDiagnostics({
      rebuildResults: [{
        status: 'failed',
        target: { pluginId: 'official/demo', platform: 'codex', scope: 'user' },
        actions: [{ name: 'preApply', status: 'failed' }],
        error: {
          phase: 'preApply',
          message: secret,
          operationDiagnostic: {
            code: 'preApplyExited', stage: 'preApply',
            safeMessage: 'The preApply process exited unsuccessfully.', exitCode: 7,
          },
        },
      }],
    }, '1:operation', [], 'pluginWrite');

    expect(projected.effects).toMatchObject({
      awWrite: 'notStarted', preApplyExternalEffect: 'possible', finalVerification: 'notStarted',
    });
    expect(projected.diagnostics[0]).toMatchObject({
      code: 'preApplyExited', stage: 'preApply', exitCode: 7,
      target: { pluginId: 'official/demo', platform: 'codex', scope: 'user' },
    });
    expect(JSON.stringify(projected)).not.toContain(secret);
  });

  it('keeps config commit separate from apply and target failures', () => {
    const projected = projectExecutionDiagnostics({
      configWrite: 'succeeded',
      apply: {
        state: 'partial',
        errors: [{ stage: 'apply', code: 'targetApplyFailed', message: 'private raw error' }],
        targetResults: [{
          target: { pluginId: 'official/demo', platform: 'claude', scope: 'project' },
          state: 'failed', errorCode: 'nativeCliTimedOut', message: 'private raw target error',
        }],
      },
    }, '2:operation', [], 'configSave');

    expect(projected.effects).toMatchObject({ configCommit: 'completed', awWrite: 'partial' });
    expect(projected.diagnostics.map((entry) => entry.code)).toEqual([
      'targetApplyFailed', 'nativeCliTimedOut',
    ]);
    expect(JSON.stringify(projected)).not.toContain('private raw');
  });

  it('marks a failed read-only preflight as no AW write', () => {
    const projected = projectExecutionDiagnostics({
      rebuildResults: [{
        status: 'failed',
        target: { pluginId: 'official/demo', platform: 'codex', scope: 'user' },
        actions: [{ name: 'preflight.inspect', status: 'failed' }],
        error: { phase: 'preflight.inspect', message: 'private failure' },
      }],
    }, '3:operation', [], 'pluginWrite');

    expect(projected.effects.awWrite).toBe('notStarted');
  });

  it('keeps observed partial cleanup mutations when a later component fails', () => {
    const projected = projectExecutionDiagnostics({
      rebuildResults: [{
        status: 'failed',
        target: { pluginId: 'official/demo', platform: 'codex', scope: 'user' },
        actions: [{ name: 'cleanup.owned', status: 'failed' }],
        removed: ['owned-a'],
        quarantined: [],
        error: { phase: 'cleanup.owned', message: 'private failure' },
      }],
    }, '4:operation', [], 'pluginWrite');

    expect(projected.effects).toMatchObject({ awWrite: 'partial', finalVerification: 'notStarted' });
  });

  it('treats successful cleanup followed by finalization failure as a completed AW write', () => {
    const projected = projectExecutionDiagnostics({
      rebuildResults: [{
        status: 'failed',
        target: { pluginId: 'official/demo', platform: 'codex', scope: 'user' },
        actions: [{ name: 'cleanup.owned', status: 'succeeded' }],
        removed: ['owned-a'],
        quarantined: [],
        error: { phase: 'cleanup.owned', message: 'private finalization failure' },
      }],
    }, '5:operation', [], 'pluginWrite');

    expect(projected.effects).toMatchObject({ awWrite: 'completed', finalVerification: 'failed' });
  });

  it('counts recovery cleanup as a write and preserves partial mutation evidence', () => {
    const projected = projectExecutionDiagnostics({
      rebuildResults: [{
        status: 'failed',
        target: { pluginId: 'official/demo', platform: 'codex', scope: 'user' },
        actions: [
          { name: 'artifacts.write', status: 'failed' },
          { name: 'recovery.cleanup', status: 'succeeded' },
        ],
        removed: [],
        quarantined: ['owned-b'],
        error: { phase: 'artifacts.write', message: 'private failure' },
      }],
    }, '6:operation', [], 'pluginWrite');

    expect(projected.effects).toMatchObject({ awWrite: 'partial', finalVerification: 'notStarted' });
  });

  it('dispatches source, bootstrap, and Catalog generation receipts by operation kind', () => {
    const source = projectExecutionDiagnostics({
      ok: false,
      changed: true,
      errors: [
        { code: 'stateInventoryFailed', message: 'Catalog source reference inventory is incomplete.' },
        { code: 'manifestUnavailable', message: 'The previous Catalog manifest is unavailable.' },
      ],
    }, '7:source', [], 'sourceMutation');
    const bootstrap = projectExecutionDiagnostics({ backupPath: 'private-backup-name' }, '7:bootstrap', [], 'catalogSourcesRecovery');
    const activation = projectExecutionDiagnostics({
      status: 'partial', partialReason: 'activation', configSaved: true,
      errorCode: 'catalogGenerationRefreshFailed', secret: 'private-token',
    }, '7:activation', ['private-token'], 'catalogGeneration');
    const primary = projectExecutionDiagnostics({
      status: 'partial', partialReason: 'primary', configSaved: true,
      activeAvailable: true, errorCode: 'catalogSourcePrimaryFailed',
    }, '7:primary', [], 'catalogGeneration');
    const primaryOnlyFailed = projectExecutionDiagnostics({
      status: 'partial', partialReason: 'primary', configSaved: false,
      activeAvailable: true, errorCode: 'catalogSourcePrimaryFailed',
    }, '7:primary-only', [], 'catalogGeneration');
    const primarySucceeded = projectExecutionDiagnostics({
      status: 'succeeded', configSaved: false, primaryChanged: true, generation: {},
    }, '7:primary-succeeded', [], 'catalogGeneration');
    const generationOnlySucceeded = projectExecutionDiagnostics({
      status: 'succeeded', configSaved: false, primaryChanged: false, generation: {},
    }, '7:generation-succeeded', [], 'catalogGeneration');

    expect(source.effects.configCommit).toBe('completed');
    expect(source.diagnostics.map((entry) => entry.code)).toEqual(['stateInventoryFailed', 'manifestUnavailable']);
    expect(source.diagnostics.map((entry) => entry.safeMessage)).toEqual([
      'Catalog source reference inventory is incomplete.',
      'The previous Catalog manifest is unavailable.',
    ]);
    expect(bootstrap.effects.configCommit).toBe('completed');
    expect(activation).toMatchObject({
      effects: { configCommit: 'completed', awWrite: 'partial', finalVerification: 'failed' },
      diagnostics: [{ code: 'catalogGenerationRefreshFailed', stage: 'activation' }],
    });
    expect(primary).toMatchObject({
      effects: { configCommit: 'partial', awWrite: 'completed', finalVerification: 'completed' },
      diagnostics: [{ code: 'catalogSourcePrimaryFailed', stage: 'primary' }],
    });
    expect(primaryOnlyFailed.effects.configCommit).toBe('failed');
    expect(primarySucceeded.effects.configCommit).toBe('completed');
    expect(generationOnlySucceeded.effects.configCommit).toBe('notApplicable');
    expect(JSON.stringify({ source, bootstrap, activation, primary })).not.toContain('private raw');
    expect(JSON.stringify(activation)).not.toContain('private-token');
  });

  it('keeps every Portable failure and missing verification fact without treating it as a platform target', () => {
    const projected = projectExecutionDiagnostics({
      status: 'partial',
      failures: [
        { code: 'portableSkillsCliInstallFailed', message: 'Authorization=private-token', recovery: '/Users/private/retry' },
        { code: 'portableSkillsCliVerificationFailed', message: 'The installed Skills could not be verified.', recovery: 'Run aw skill install again.' },
      ],
      verification: {
        records: [],
        missing: [{ skill: 'review', agent: 'codex' }, { skill: 'audit' }],
      },
    }, '8:portable', ['private-token'], 'portableInstall');

    expect(projected.effects).toEqual({
      configCommit: 'notApplicable', awWrite: 'partial',
      preApplyExternalEffect: 'notApplicable', finalVerification: 'unknown',
    });
    expect(projected.diagnostics.map(({ code, stage, target }) => ({ code, stage, target }))).toEqual([
      { code: 'portableSkillsCliInstallFailed', stage: 'portable.add', target: undefined },
      { code: 'portableSkillsCliVerificationFailed', stage: 'portable.verify', target: undefined },
      { code: 'portableVerificationMissing', stage: 'portable.verify', target: undefined },
      { code: 'portableVerificationMissing', stage: 'portable.verify', target: undefined },
    ]);
    expect(projected.diagnostics[2]?.detailLines).toEqual(['Skill: review', 'Agent: codex']);
    expect(projected.diagnostics[3]?.detailLines).toEqual(['Skill: audit']);
    expect(projected.diagnostics[1]).toMatchObject({
      safeMessage: 'The installed Skills could not be verified.',
      detailLines: ['Recovery: Run aw skill install again.'],
    });
    expect(JSON.stringify(projected)).not.toContain('private-token');
    expect(JSON.stringify(projected)).not.toContain('/Users/private');
    expect(projected.targetEffects.size).toBe(0);
  });

  it('does not treat an empty verification object on a failed Portable receipt as completed', () => {
    const failed = projectExecutionDiagnostics({
      status: 'failed', failures: [], verification: { records: [], missing: [] },
    }, '9:portable-failed', [], 'portableInstall');
    const succeeded = projectExecutionDiagnostics({
      status: 'succeeded', failures: [],
      verification: { records: [{ name: 'review', agents: ['codex'] }], missing: [] },
    }, '9:portable-succeeded', [], 'portableInstall');

    expect(failed.effects.finalVerification).toBe('unknown');
    expect(succeeded.effects.finalVerification).toBe('completed');
  });
});
