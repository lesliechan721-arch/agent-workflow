import type {
  OperationDiagnosticDetail,
  OperationEffectFacts,
  OperationEffectState,
  OperationHistorySummary,
} from './operation-history.js';
import type { TuiStatus } from './theme.js';

interface DetailLine {
  title: string;
  meta?: string;
}

const operationStatePresentation: Record<OperationHistorySummary['state'], {
  label: string;
  status: TuiStatus;
}> = {
  succeeded: { label: '已完成', status: 'success' },
  partial: { label: '部分完成', status: 'warning' },
  blocked: { label: '未完成', status: 'error' },
};

const effectPresentation: Record<OperationEffectState, string> = {
  notApplicable: '不适用',
  notStarted: '未开始',
  started: '已开始',
  partial: '部分完成',
  possible: '可能已影响外部系统',
  completed: '已完成',
  failed: '失败',
  unknown: '未确认',
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
      meta: effectPresentation[state],
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

function operationDiagnosticLines(detail: OperationDiagnosticDetail): DetailLine[] {
  const lines: DetailLine[] = [
    { title: '操作代码', meta: detail.summary.code },
    ...effectLines(detail.summary.effects),
  ];
  for (const [index, diagnostic] of detail.diagnostics.entries()) {
    lines.push(
      { title: `诊断 ${index + 1} · ${diagnostic.code}` },
      ...(diagnostic.stage ? [{ title: '阶段', meta: diagnostic.stage }] : []),
      ...(diagnostic.target ? [{ title: '目标', meta: targetLabel(diagnostic.target) }] : []),
      ...(diagnostic.exitCode === undefined
        ? []
        : [{ title: '退出码', meta: String(diagnostic.exitCode) }]),
      { title: diagnostic.safeMessage },
      ...diagnostic.causes.map((cause) => ({
        title: cause.safeMessage,
        ...(cause.code ? { meta: cause.code } : {}),
      })),
      ...diagnostic.detailLines.map((line) => ({ title: line })),
      ...(diagnostic.omitted ? [{
        title: '部分安全详情未保留',
        meta: diagnostic.omitted.count === undefined
          ? diagnostic.omitted.reason
          : `${diagnostic.omitted.reason} · ${diagnostic.omitted.count} 行`,
      }] : []),
    );
  }
  for (const target of detail.targets) {
    const targetDiagnostics = detail.diagnostics.filter((diagnostic) =>
      target.diagnosticIds.includes(diagnostic.id));
    lines.push(
      { title: `目标 · ${targetLabel(target)}`, meta: target.state },
      ...(target.errorCode ? [{ title: '目标代码', meta: target.errorCode }] : []),
      ...(target.effects ? effectLines(target.effects) : []),
      ...targetDiagnostics.flatMap((diagnostic) => [
        ...(diagnostic.stage ? [{ title: '目标阶段', meta: diagnostic.stage }] : []),
        { title: diagnostic.safeMessage },
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
