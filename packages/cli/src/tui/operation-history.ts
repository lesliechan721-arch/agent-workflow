import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';

import type { OperationKind } from './controller.js';
import {
  safeDiagnosticCode,
  sanitizeDiagnosticDetailText,
  sanitizeDiagnosticText,
} from './diagnostics.js';

export type OperationEffectState =
  | 'notApplicable'
  | 'notStarted'
  | 'started'
  | 'partial'
  | 'possible'
  | 'completed'
  | 'failed'
  | 'unknown';

export interface OperationEffectFacts {
  configCommit: OperationEffectState;
  awWrite: OperationEffectState;
  preApplyExternalEffect: OperationEffectState;
  finalVerification: OperationEffectState;
}

export interface SafeOperationDiagnostic {
  id: string;
  code: string;
  stage?: string;
  sourceId?: string;
  safeMessage: string;
  target?: { pluginId?: string; platform: 'codex' | 'claude'; scope: 'user' | 'project' };
  exitCode?: number;
  causes: Array<{ code?: string; safeMessage: string }>;
  detailLines: string[];
  omitted?: { reason: 'privacy' | 'unsupportedFormat' | 'limit'; count?: number };
}

export interface OperationHistorySummary {
  recordId: string;
  epoch: number;
  operationId: string;
  createdAtMs: number;
  state: 'succeeded' | 'partial' | 'blocked';
  code: string;
  message: string;
  operationKind?: OperationKind;
  pluginId?: string;
  diagnosticCount: number;
  effects: OperationEffectFacts;
}

export interface OperationDiagnosticDetail {
  summary: OperationHistorySummary;
  diagnostics: SafeOperationDiagnostic[];
  targets: OperationHistoryTarget[];
}

export interface OperationHistoryTarget {
  pluginId?: string;
  platform: 'codex' | 'claude';
  scope: 'user' | 'project';
  state: 'completed' | 'kept' | 'failed' | 'skipped';
  errorCode?: string;
  diagnosticIds: string[];
  effects?: OperationEffectFacts;
}

export interface OperationReportPreview {
  recordId: string;
  fileName: string;
  content: string;
  omitted: boolean;
}

export interface SaveOperationReportResult { path: string }

export interface OperationHistoryRecord {
  summary: OperationHistorySummary;
  diagnostics: SafeOperationDiagnostic[];
  targets: OperationHistoryTarget[];
}

const MAX_RECORDS = 20;
const MAX_DETAIL_LINES = 1_000;
const MAX_DETAIL_BYTES = 256 * 1024;

function boundDiagnostics(
  diagnostics: readonly SafeOperationDiagnostic[],
  sensitiveValues: readonly string[],
): SafeOperationDiagnostic[] {
  let bytes = 0;
  let lines = 0;
  return diagnostics.map((diagnostic) => {
    const kept: string[] = [];
    let omittedLines = 0;
    for (const line of diagnostic.detailLines) {
      const safeLine = sanitizeDiagnosticDetailText(line, [], sensitiveValues);
      const lineBytes = Buffer.byteLength(`${safeLine}\n`);
      if (lines >= MAX_DETAIL_LINES || bytes + lineBytes > MAX_DETAIL_BYTES) {
        omittedLines += 1;
        continue;
      }
      kept.push(safeLine);
      lines += 1;
      bytes += lineBytes;
    }
    return {
      id: sanitizeDiagnosticText(diagnostic.id, [], sensitiveValues),
      code: safeDiagnosticCode(diagnostic.code, 'operationFailed'),
      ...(diagnostic.stage
        ? { stage: safeDiagnosticCode(diagnostic.stage, 'execute') }
        : {}),
      ...(diagnostic.sourceId
        ? { sourceId: safeDiagnosticCode(diagnostic.sourceId, 'unknownSource') }
        : {}),
      safeMessage: sanitizeDiagnosticText(diagnostic.safeMessage, [], sensitiveValues),
      ...(diagnostic.target ? { target: structuredClone(diagnostic.target) } : {}),
      ...(diagnostic.exitCode !== undefined && Number.isSafeInteger(diagnostic.exitCode)
        ? { exitCode: diagnostic.exitCode }
        : {}),
      causes: diagnostic.causes.map((cause) => ({
        ...(cause.code ? { code: safeDiagnosticCode(cause.code, 'operationCause') } : {}),
        safeMessage: sanitizeDiagnosticText(cause.safeMessage, [], sensitiveValues),
      })),
      detailLines: kept,
      ...(omittedLines > 0
        ? { omitted: { reason: 'limit' as const, count: omittedLines } }
        : diagnostic.omitted ? { omitted: structuredClone(diagnostic.omitted) } : {}),
    };
  });
}

function reportContent(record: OperationHistoryRecord): string {
  const { summary } = record;
  const lines = [
    '# AW TUI operation report',
    '',
    `Record: ${summary.recordId}`,
    `State: ${summary.state}`,
    `Code: ${summary.code}`,
    `Message: ${summary.message}`,
    `Effects: ${JSON.stringify(summary.effects)}`,
  ];
  for (const target of record.targets) {
    lines.push(
      '',
      `Target: ${target.pluginId ?? 'unknown'} ${target.platform}/${target.scope}`,
      `Target state: ${target.state}`,
      ...(target.errorCode ? [`Target code: ${target.errorCode}`] : []),
      ...(target.effects ? [`Target effects: ${JSON.stringify(target.effects)}`] : []),
    );
  }
  for (const diagnostic of record.diagnostics) {
    lines.push('', `## ${diagnostic.code}`, `Stage: ${diagnostic.stage ?? 'unknown'}`);
    if (diagnostic.sourceId) lines.push(`Source: ${diagnostic.sourceId}`);
    if (diagnostic.target) lines.push(`Target: ${JSON.stringify(diagnostic.target)}`);
    if (diagnostic.exitCode !== undefined) lines.push(`Exit code: ${diagnostic.exitCode}`);
    lines.push(`Message: ${diagnostic.safeMessage}`);
    for (const cause of diagnostic.causes) {
      lines.push(`Cause${cause.code ? ` (${cause.code})` : ''}: ${cause.safeMessage}`);
    }
    lines.push(...diagnostic.detailLines);
    if (diagnostic.omitted) {
      lines.push(`[omitted: ${diagnostic.omitted.reason}${diagnostic.omitted.count === undefined ? '' : `, ${diagnostic.omitted.count} line(s)`}]`);
    }
  }
  return `${lines.join('\n')}\n`;
}

export class OperationHistoryStore {
  #records: OperationHistoryRecord[] = [];

  record(record: OperationHistoryRecord, options: { sensitiveValues?: readonly string[] } = {}): void {
    const sensitiveValues = options.sensitiveValues ?? [];
    const bounded = {
      summary: {
        ...structuredClone(record.summary),
        code: safeDiagnosticCode(record.summary.code, 'operationFailed'),
        message: sanitizeDiagnosticText(record.summary.message, [], sensitiveValues),
      },
      diagnostics: boundDiagnostics(record.diagnostics, sensitiveValues),
      targets: structuredClone(record.targets),
    };
    const index = this.#records.findIndex((entry) => entry.summary.recordId === bounded.summary.recordId);
    if (index >= 0) {
      bounded.summary.createdAtMs = this.#records[index]!.summary.createdAtMs;
      this.#records.splice(index, 1);
    }
    this.#records.unshift(bounded);
    this.#records = this.#records.slice(0, MAX_RECORDS);
  }

  list(): OperationHistorySummary[] {
    return this.#records.map((record) => structuredClone(record.summary));
  }

  get(recordId: string): OperationDiagnosticDetail | undefined {
    const record = this.#records.find((entry) => entry.summary.recordId === recordId);
    return record ? structuredClone({
      summary: record.summary,
      diagnostics: record.diagnostics,
      targets: record.targets,
    }) : undefined;
  }

  preview(recordId: string): OperationReportPreview | undefined {
    const record = this.#records.find((entry) => entry.summary.recordId === recordId);
    if (!record) return undefined;
    return {
      recordId,
      fileName: `aw-tui-report-${recordId.replace(/[^A-Za-z0-9._-]/gu, '-')}.md`,
      content: reportContent(record),
      omitted: record.diagnostics.some((diagnostic) => diagnostic.omitted !== undefined),
    };
  }

  async save(recordId: string, filePath?: string): Promise<SaveOperationReportResult> {
    const preview = this.preview(recordId);
    if (!preview) throw new Error('operationReportMissing: The operation report is no longer available.');
    const target = filePath ?? path.join(os.tmpdir(), `aw-tui-report-${randomUUID()}.md`);
    await fs.writeFile(target, preview.content, { flag: 'wx', encoding: 'utf8' });
    return { path: target };
  }
}
