import { Box, Text } from 'ink';

import {
  ResultCard,
  StaticRow,
  TechnicalDetails,
} from './components.js';
import type {
  OperationDiagnosticDetail,
  OperationEffectFacts,
  OperationEffectState,
  OperationHistorySummary,
  OperationReportPreview,
} from './operation-history.js';
import { getTuiStatusColor, type TuiStatus } from './theme.js';
import { wrapDisplayText } from './viewport.js';

interface DetailLine {
  title: string;
  meta?: string;
  status?: TuiStatus;
}

function SafeDetailLine(props: { line: string; status?: TuiStatus }): React.JSX.Element {
  return (
    <Box paddingX={1}>
      <Text color={getTuiStatusColor(props.status ?? 'muted')} wrap="wrap">{props.line}</Text>
    </Box>
  );
}

const operationStatePresentation: Record<OperationHistorySummary['state'], {
  label: string;
  status: TuiStatus;
}> = {
  succeeded: { label: '已完成', status: 'success' },
  partial: { label: '部分完成', status: 'warning' },
  blocked: { label: '未完成', status: 'error' },
};

const effectPresentation: Record<OperationEffectState, {
  label: string;
  status: TuiStatus;
}> = {
  notApplicable: { label: '不适用', status: 'muted' },
  notStarted: { label: '未开始', status: 'muted' },
  started: { label: '已开始', status: 'info' },
  partial: { label: '部分完成', status: 'warning' },
  possible: { label: '可能已影响外部系统', status: 'warning' },
  completed: { label: '已完成', status: 'success' },
  failed: { label: '失败', status: 'error' },
  unknown: { label: '未确认', status: 'warning' },
};

const effectLabels: Record<keyof OperationEffectFacts, string> = {
  configCommit: '设置提交',
  awWrite: 'AW 写入',
  preApplyExternalEffect: '安装前外部操作',
  finalVerification: '最终复核',
};

function effectLines(effects: OperationEffectFacts): DetailLine[] {
  return (Object.entries(effects) as Array<[keyof OperationEffectFacts, OperationEffectState]>).map(
    ([name, state]) => ({
      title: effectLabels[name],
      meta: effectPresentation[state].label,
      status: effectPresentation[state].status,
    }),
  );
}

function targetLabel(target: { pluginId?: string; platform: 'codex' | 'claude'; scope: 'user' | 'project' }): string {
  const scope = target.scope === 'project' ? '当前项目' : '所有项目';
  const platform = target.platform === 'codex' ? 'Codex' : 'Claude Code';
  return [target.pluginId, platform, scope].filter((value): value is string => Boolean(value)).join(' · ');
}

export function operationHistoryState(summary: OperationHistorySummary): {
  label: string;
  status: TuiStatus;
} {
  return operationStatePresentation[summary.state];
}

export function operationHistoryMeta(summary: OperationHistorySummary): string {
  return summary.operationKind ? `${summary.operationKind} · ${summary.code}` : summary.code;
}

export function operationDiagnosticLineCount(
  detail: OperationDiagnosticDetail,
  columns: number,
): number {
  return wrappedDiagnosticLines(detail, columns).length;
}

function operationDiagnosticLines(detail: OperationDiagnosticDetail): DetailLine[] {
  const lines: DetailLine[] = [
    { title: '操作代码', meta: detail.summary.code, status: operationHistoryState(detail.summary).status },
    ...effectLines(detail.summary.effects),
  ];
  for (const [index, diagnostic] of detail.diagnostics.entries()) {
    lines.push(
      { title: `诊断 ${index + 1} · ${diagnostic.code}`, status: 'error' },
      ...(diagnostic.stage ? [{ title: '阶段', meta: diagnostic.stage, status: 'muted' as const }] : []),
      ...(diagnostic.target ? [{ title: '目标', meta: targetLabel(diagnostic.target), status: 'muted' as const }] : []),
      ...(diagnostic.exitCode === undefined
        ? []
        : [{ title: '退出码', meta: String(diagnostic.exitCode), status: 'muted' as const }]),
      { title: diagnostic.safeMessage, status: 'warning' },
      ...diagnostic.causes.map((cause) => ({
        title: cause.safeMessage,
        ...(cause.code ? { meta: cause.code } : {}),
        status: 'muted' as const,
      })),
      ...diagnostic.detailLines.map((line) => ({ title: line, status: 'muted' as const })),
      ...(diagnostic.omitted ? [{
        title: '部分安全详情未保留',
        meta: diagnostic.omitted.count === undefined
          ? diagnostic.omitted.reason
          : `${diagnostic.omitted.reason} · ${diagnostic.omitted.count} 行`,
        status: 'warning' as const,
      }] : []),
    );
  }
  for (const target of detail.targets) {
    const targetDiagnostics = detail.diagnostics.filter((diagnostic) =>
      target.diagnosticIds.includes(diagnostic.id));
    const targetState = target.state === 'completed' || target.state === 'kept'
      ? 'success' as const : target.state === 'failed' ? 'error' as const : 'warning' as const;
    lines.push(
      { title: `目标 · ${targetLabel(target)}`, meta: target.state, status: targetState },
      ...(target.errorCode ? [{ title: '目标代码', meta: target.errorCode, status: targetState }] : []),
      ...(target.effects ? effectLines(target.effects) : []),
      ...targetDiagnostics.flatMap((diagnostic) => [
        ...(diagnostic.stage ? [{ title: '目标阶段', meta: diagnostic.stage, status: 'muted' as const }] : []),
        { title: diagnostic.safeMessage, status: targetState },
      ]),
    );
  }
  return lines;
}

export function operationDiagnosticText(detail: OperationDiagnosticDetail): string {
  return operationDiagnosticLines(detail)
    .map((line) => `${line.title}${line.meta ? ` · ${line.meta}` : ''}`)
    .join('\n');
}

function wrappedDiagnosticLines(detail: OperationDiagnosticDetail, columns: number): DetailLine[] {
  return operationDiagnosticLines(detail).flatMap((line) => {
    const value = `${line.title}${line.meta ? ` · ${line.meta}` : ''}`;
    return wrapDisplayText(value, Math.max(1, columns - 8)).map((title) => ({
      title: title || ' ',
      status: line.status,
    }));
  });
}

export function OperationDiagnosticScreen(props: {
  detail: OperationDiagnosticDetail;
  compact: boolean;
  columns: number;
  offset: number;
  limit: number;
}): React.JSX.Element {
  const state = operationHistoryState(props.detail.summary);
  const lines = wrappedDiagnosticLines(props.detail, props.columns);
  const offset = Math.min(Math.max(0, props.offset), Math.max(0, lines.length - 1));
  const visible = lines.slice(offset, offset + Math.max(1, props.limit));
  const hiddenBefore = offset;
  const hiddenAfter = Math.max(0, lines.length - offset - visible.length);
  return (
    <Box flexDirection="column">
      {props.compact ? null
        : <ResultCard status={state.status} title={props.detail.summary.message} meta={state.label} compact={false} />}
      <TechnicalDetails label="安全技术详情" compact={props.compact}>
        {hiddenBefore > 0 ? <StaticRow title={`↑ 还有 ${hiddenBefore} 行`} status="muted" compact /> : null}
        {visible.map((line, index) => <SafeDetailLine
          key={`${offset + index}:${line.title}`}
          line={line.title}
          status={line.status}
        />)}
        {hiddenAfter > 0 ? <StaticRow title={`↓ 还有 ${hiddenAfter} 行`} status="muted" compact /> : null}
      </TechnicalDetails>
    </Box>
  );
}

export function operationReportLineCount(preview: OperationReportPreview, columns: number): number {
  return wrappedReportLines(preview, columns).length;
}

function reportLines(preview: OperationReportPreview): string[] {
  const lines = preview.content.split(/\r?\n/u);
  return lines[0]?.startsWith('# ') ? lines.slice(2) : lines;
}

function wrappedReportLines(preview: OperationReportPreview, columns: number): string[] {
  return reportLines(preview).flatMap((line) =>
    wrapDisplayText(line, Math.max(1, columns - 8)));
}

export function OperationReportPreviewScreen(props: {
  preview: OperationReportPreview;
  compact: boolean;
  columns: number;
  offset: number;
  limit: number;
}): React.JSX.Element {
  const lines = wrappedReportLines(props.preview, props.columns);
  const offset = Math.min(Math.max(0, props.offset), Math.max(0, lines.length - 1));
  const visible = lines.slice(offset, offset + Math.max(1, props.limit));
  const hiddenBefore = offset;
  const hiddenAfter = Math.max(0, lines.length - offset - visible.length);
  return (
    <Box flexDirection="column">
      {props.compact ? null : <ResultCard
        status={props.preview.omitted ? 'warning' : 'info'}
        title="报告预览"
        description={props.preview.omitted ? '报告只包含已保留的安全内容。' : '报告只包含本页安全内容。'}
        meta={props.preview.fileName}
        compact={props.compact}
      />}
      <TechnicalDetails label="报告内容" compact={props.compact}>
        {hiddenBefore > 0 ? <StaticRow title={`↑ 还有 ${hiddenBefore} 行`} status="muted" compact /> : null}
        {visible.map((line, index) => <SafeDetailLine
          key={`${offset + index}:${line}`}
          line={line || ' '}
          status="muted"
        />)}
        {hiddenAfter > 0 ? <StaticRow title={`↓ 还有 ${hiddenAfter} 行`} status="muted" compact /> : null}
      </TechnicalDetails>
    </Box>
  );
}
