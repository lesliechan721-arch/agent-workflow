import { describe, expect, it } from 'vitest';

import { operationDiagnosticText } from '../../src/tui/operation-diagnostic-screens.js';
import { OperationHistoryStore, type OperationHistoryRecord } from '../../src/tui/operation-history.js';

describe('TUI reading copy', () => {
  it('keeps the complete safe diagnostic line without terminal soft wraps', () => {
    const history = new OperationHistoryStore();
    const longLine = `safe ${'a'.repeat(100)} END`;
    const record: OperationHistoryRecord = {
      summary: {
        recordId: 'reader-1', epoch: 1, operationId: 'reader', createdAtMs: 1,
        state: 'blocked', code: 'operationBlocked', message: '操作受阻', diagnosticCount: 1,
        effects: {
          configCommit: 'notStarted', awWrite: 'notStarted',
          preApplyExternalEffect: 'notStarted', finalVerification: 'notStarted',
        },
      },
      diagnostics: [{
        id: 'diagnostic-1', code: 'safeFailure', safeMessage: '安全原因',
        causes: [], detailLines: [longLine, 'secret-value'],
      }],
      targets: [],
    };
    history.record(record, { sensitiveValues: ['secret-value'] });
    const detail = history.get('reader-1');
    expect(detail).toBeDefined();
    const copied = operationDiagnosticText(detail!);
    expect(copied).toContain(longLine);
    expect(copied).toContain('END');
    expect(copied).toContain('[REDACTED]');
    expect(copied).not.toContain('secret-value');
  });
});
