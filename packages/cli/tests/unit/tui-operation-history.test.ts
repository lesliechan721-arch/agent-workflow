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
    }, '1:operation');

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
    }, '2:operation');

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
    }, '3:operation');

    expect(projected.effects.awWrite).toBe('notStarted');
  });
});
