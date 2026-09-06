import { Box, Text, useWindowSize } from 'ink';
import type { ReactNode } from 'react';

import {
  safeDiagnosticCode,
  sanitizeDiagnosticCause,
  sanitizeDiagnosticText,
  type DiagnosticSummaryViewModel,
} from './diagnostics.js';
import { resolveTuiSizePolicy, type TuiSizePolicy } from './layout.js';
import { getTuiStatusColor, tuiTheme, type TuiStatus } from './theme.js';

export interface TuiSize {
  columns: number;
  rows: number;
}

export function HelpBar(props: {
  children: ReactNode;
  compact?: boolean;
}): React.JSX.Element {
  return (
    <Box
      backgroundColor={tuiTheme.colors.panelBackground}
      borderStyle="single"
      borderColor={tuiTheme.colors.border}
      borderLeft={false}
      borderRight={false}
      borderBottom={false}
      paddingX={1}
      maxHeight={props.compact ? 3 : 2}
      overflow="hidden"
    >
      <Text color={tuiTheme.colors.muted} wrap={props.compact ? 'wrap' : 'truncate-end'}>
        {props.children}
      </Text>
    </Box>
  );
}

function SizeHint(props: { policy: TuiSizePolicy }): React.JSX.Element {
  return (
    <Box
      flexDirection="column"
      width={props.policy.columns}
      height={props.policy.rows}
      overflow="hidden"
      paddingX={1}
      backgroundColor={tuiTheme.colors.background}
    >
      <Text color={tuiTheme.statusColors.warning}>↔ {props.policy.message}</Text>
      <Text color={tuiTheme.colors.muted}>
        当前：{props.policy.columns} 列 × {props.policy.rows} 行。
      </Text>
      <Text color={tuiTheme.colors.muted}>q 退出</Text>
    </Box>
  );
}

export function ScreenFrame(props: {
  title: string;
  description?: string;
  breadcrumb?: string;
  context?: string;
  help: ReactNode;
  children: ReactNode;
  size?: TuiSize;
}): React.JSX.Element {
  const windowSize = useWindowSize();
  const size = props.size ?? windowSize;
  const policy = resolveTuiSizePolicy(size.columns, size.rows);

  if (policy.mode === 'too-small') {
    return <SizeHint policy={policy} />;
  }

  return (
    <Box
      flexDirection="column"
      width={policy.columns}
      height={policy.rows}
      overflow="hidden"
      backgroundColor={tuiTheme.colors.background}
    >
      <Box
        justifyContent="space-between"
        backgroundColor={tuiTheme.colors.panelBackground}
        borderStyle="single"
        borderColor={tuiTheme.colors.border}
        borderTop={false}
        borderLeft={false}
        borderRight={false}
        paddingX={1}
      >
        <Text bold color={tuiTheme.colors.accent} wrap="truncate-end">
          AW{props.breadcrumb ? ` / ${props.breadcrumb}` : ''}
        </Text>
        {props.context
          ? <Text color={tuiTheme.colors.muted} wrap="truncate-end">{props.context}</Text>
          : null}
      </Box>
      <Box flexDirection="column" flexGrow={1} overflow="hidden" paddingX={1}>
        <Text bold color={tuiTheme.colors.text}>{props.title}</Text>
        {props.description
          ? <Text color={tuiTheme.colors.muted}>{props.description}</Text>
          : null}
        <Box flexDirection="column" flexGrow={1} overflow="hidden">
          {props.children}
        </Box>
      </Box>
      <HelpBar compact={policy.mode === 'compact'}>{props.help}</HelpBar>
    </Box>
  );
}

export function Card(props: {
  children: ReactNode;
  status?: TuiStatus;
}): React.JSX.Element {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={props.status ? getTuiStatusColor(props.status) : tuiTheme.colors.border}
      backgroundColor={tuiTheme.colors.panelBackground}
      paddingX={1}
    >
      {props.children}
    </Box>
  );
}

export function Section(props: {
  title: string;
  description?: string;
  children: ReactNode;
}): React.JSX.Element {
  return (
    <Card>
      <Text bold>{props.title}</Text>
      {props.description
        ? <Text color={tuiTheme.colors.muted}>{props.description}</Text>
        : null}
      <Box flexDirection="column">{props.children}</Box>
    </Card>
  );
}

const statusSymbols: Record<TuiStatus, string> = {
  success: '✓',
  warning: '!',
  error: '×',
  info: '●',
  muted: '○',
};

export function StatusLabel(props: {
  status: TuiStatus;
  children: ReactNode;
}): React.JSX.Element {
  return (
    <Text color={getTuiStatusColor(props.status)}>
      {statusSymbols[props.status]} {props.children}
    </Text>
  );
}

export interface SemanticCardProps {
  children?: ReactNode;
  title?: ReactNode;
  description?: ReactNode;
  meta?: ReactNode;
  label?: ReactNode;
  status?: TuiStatus;
  compact?: boolean;
}

function SemanticCard(props: SemanticCardProps & {
  backgroundColor?: string;
  borderColor?: string;
}): React.JSX.Element {
  const borderColor = props.status
    ? getTuiStatusColor(props.status)
    : props.borderColor ?? tuiTheme.colors.border;
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={borderColor}
      backgroundColor={props.backgroundColor ?? tuiTheme.colors.panelBackground}
      paddingX={props.compact ? 0 : 1}
    >
      {props.label
        ? <Text bold color={borderColor}>─ {props.label}</Text>
        : null}
      {props.title || props.meta
        ? (
            <Box justifyContent="space-between">
              <Box flexGrow={1} flexShrink={1} overflow="hidden">
                <Text bold color={tuiTheme.colors.text} wrap="truncate-end">{props.title}</Text>
              </Box>
              {props.meta
                ? (
                    <Box flexShrink={1} overflow="hidden" marginLeft={1}>
                      <Text color={tuiTheme.colors.muted} wrap="truncate-end">{props.meta}</Text>
                    </Box>
                  )
                : null}
            </Box>
          )
        : null}
      {props.description
        ? <Text color={tuiTheme.colors.muted} wrap="truncate-end">{props.description}</Text>
        : null}
      {props.children}
    </Box>
  );
}

export function SectionCard(props: SemanticCardProps): React.JSX.Element {
  return <SemanticCard {...props} />;
}

export function StatusCard(props: SemanticCardProps & { status: TuiStatus }): React.JSX.Element {
  return <SemanticCard {...props} borderColor={tuiTheme.colors.borderStrong} />;
}

export function ReviewCard(props: SemanticCardProps): React.JSX.Element {
  return <SemanticCard {...props} borderColor={tuiTheme.colors.borderStrong} />;
}

export function ResultCard(props: SemanticCardProps): React.JSX.Element {
  return <SemanticCard {...props} borderColor={tuiTheme.colors.borderStrong} />;
}

export function InputCard(props: SemanticCardProps & { focused?: boolean }): React.JSX.Element {
  return (
    <SemanticCard
      {...props}
      backgroundColor={tuiTheme.colors.inputBackground}
      borderColor={props.focused ? tuiTheme.colors.accent : tuiTheme.colors.border}
    />
  );
}

export function Callout(props: SemanticCardProps): React.JSX.Element {
  return <SemanticCard {...props} status={props.status ?? 'info'} compact={props.compact ?? true} />;
}

export function TechnicalDetails(props: SemanticCardProps): React.JSX.Element {
  return (
    <SemanticCard
      {...props}
      label={props.label ?? '技术详情'}
      borderColor={tuiTheme.colors.border}
      compact={props.compact ?? true}
    />
  );
}

const diagnosticContextLabels = {
  platform: '平台',
  scope: '范围',
  pluginId: '插件',
  dependencyPluginId: '依赖插件',
  field: '字段',
  storeEntry: 'Store 条目',
  compatibility: '兼容版本',
} as const;

interface DiagnosticDetailRow {
  label: string;
  value: string;
}

function diagnosticDetailRows(diagnostic: DiagnosticSummaryViewModel): DiagnosticDetailRow[] {
  const technical = diagnostic.technical;
  if (!technical) return [];

  const cause = sanitizeDiagnosticCause(technical.sanitizedCause);
  return [
    { label: 'code', value: safeDiagnosticCode(technical.code, 'diagnosticUnavailable') },
    ...(technical.stage ? [{ label: 'stage', value: sanitizeDiagnosticText(technical.stage) }] : []),
    ...(technical.sourceId ? [{ label: 'sourceId', value: sanitizeDiagnosticText(technical.sourceId) }] : []),
    ...(technical.requestedRef ? [{ label: 'requested ref', value: sanitizeDiagnosticText(technical.requestedRef) }] : []),
    ...(technical.resolvedCommit ? [{ label: 'resolved commit', value: sanitizeDiagnosticText(technical.resolvedCommit) }] : []),
    ...(technical.context ?? []).map((entry) => ({
      label: diagnosticContextLabels[entry.key],
      value: sanitizeDiagnosticText(entry.value),
    })),
    ...(cause ? [{ label: 'cause', value: cause }] : []),
    ...(technical.checks ?? []).map((check, index) => ({
      label: `建议 ${index + 1}`,
      value: sanitizeDiagnosticText(check),
    })),
  ];
}

export function diagnosticDetailRowCount(diagnostic: DiagnosticSummaryViewModel): number {
  return diagnosticDetailRows(diagnostic).length;
}

export function DiagnosticSummary(props: {
  diagnostic: DiagnosticSummaryViewModel;
  technical?: boolean;
  compact?: boolean;
  offset?: number;
  limit?: number;
}): React.JSX.Element {
  const compact = props.compact === true;
  if (!props.technical) {
    if (compact) {
      return <SectionCard
        title={sanitizeDiagnosticText(props.diagnostic.title)}
        description={sanitizeDiagnosticText(props.diagnostic.userMessage)}
        status={props.diagnostic.severity}
        compact
      >
        {props.diagnostic.impact.map((entry, index) => <ResultRow
          key={`${entry.state}:${index}`}
          title={sanitizeDiagnosticText(entry.message)}
          status={entry.state === 'blocked' ? 'error' : entry.state === 'preserved' ? 'success' : 'muted'}
          compact
        />)}
        <StaticRow title={`下一步：${sanitizeDiagnosticText(props.diagnostic.nextStep)}`} status="info" compact />
      </SectionCard>;
    }
    return <Box flexDirection="column">
      <StatusCard
        status={props.diagnostic.severity}
        title={sanitizeDiagnosticText(props.diagnostic.title)}
        description={sanitizeDiagnosticText(props.diagnostic.userMessage)}
        compact={compact}
      />
      <SectionCard title="影响" compact={compact}>
        {props.diagnostic.impact.map((entry, index) => <ResultRow
          key={`${entry.state}:${index}`}
          title={sanitizeDiagnosticText(entry.message)}
          status={entry.state === 'blocked' ? 'error' : entry.state === 'preserved' ? 'success' : 'muted'}
          compact
        />)}
      </SectionCard>
      <Callout
        status="info"
        title="下一步"
        description={sanitizeDiagnosticText(props.diagnostic.nextStep)}
        compact
      />
    </Box>;
  }

  const technical = props.diagnostic.technical;
  if (!technical) {
    return <Callout status="muted" title="没有可公开的技术字段" compact />;
  }
  const rows = diagnosticDetailRows(props.diagnostic);
  const total = rows.length;
  const offset = Math.min(
    total,
    Math.max(0, Math.floor(Number.isFinite(props.offset) ? props.offset ?? 0 : 0)),
  );
  const limit = props.limit === undefined
    ? total
    : Math.max(0, Math.floor(Number.isFinite(props.limit) ? props.limit : 0));
  const visibleRows = rows.slice(offset, offset + limit);
  const after = total - offset - visibleRows.length;

  return <Box flexDirection="column">
    <Text color={tuiTheme.colors.muted}>下面的信息已脱敏，可用于排查或提交 issue。</Text>
    <TechnicalDetails label="脱敏诊断" compact>
      {offset > 0 ? <StaticRow title={`↑ 前面还有 ${offset} 项`} status="muted" compact /> : null}
      {visibleRows.map((field, index) => <StaticRow
        key={`${field.label}:${offset + index}`}
        title={field.label}
        meta={field.value}
        compact
      />)}
      {after > 0 ? <StaticRow title={`↓ 后面还有 ${after} 项`} status="muted" compact /> : null}
    </TechnicalDetails>
  </Box>;
}

export interface InteractiveRowProps {
  title: ReactNode;
  description?: ReactNode;
  meta?: ReactNode;
  focused?: boolean;
  disabled?: boolean | string;
  status?: TuiStatus;
  compact?: boolean;
}

export interface SelectableRowProps extends InteractiveRowProps {
  selected: boolean;
}

function FocusRow(props: InteractiveRowProps & { marker?: string }): React.JSX.Element {
  const description = typeof props.disabled === 'string' ? props.disabled : props.description;
  const color = props.disabled
    ? tuiTheme.colors.muted
    : props.status ? getTuiStatusColor(props.status) : tuiTheme.colors.text;
  return (
    <Box
      flexDirection="column"
      backgroundColor={props.focused ? tuiTheme.colors.selectionBackground : undefined}
      paddingX={1}
    >
      <Box justifyContent="space-between">
        <Box flexGrow={1} flexShrink={1} overflow="hidden">
          <Text color={color} bold={props.focused && !props.disabled} wrap="truncate-end">
            {props.focused ? '›' : ' '} {props.marker ? `${props.marker} ` : ''}{props.title}
          </Text>
        </Box>
        {props.meta
          ? (
              <Box flexShrink={1} overflow="hidden" marginLeft={1}>
                <Text color={props.disabled ? tuiTheme.colors.muted : color} wrap="truncate-end">
                  {props.meta}
                </Text>
              </Box>
            )
          : null}
      </Box>
      {description && !props.compact
        ? <Text color={tuiTheme.colors.muted} wrap="truncate-end">  {description}</Text>
        : null}
    </Box>
  );
}

export function TaskRow(props: InteractiveRowProps): React.JSX.Element {
  return <FocusRow {...props} />;
}

export function PluginRow(props: InteractiveRowProps): React.JSX.Element {
  return <FocusRow {...props} />;
}

export interface PluginListRowProps {
  name: ReactNode;
  sourceLabel: ReactNode;
  description: ReactNode;
  attention?: ReactNode;
  placementSummary: ReactNode;
  statusLabel: ReactNode;
  status: TuiStatus;
  focused?: boolean;
}

export function PluginListRow(props: PluginListRowProps): React.JSX.Element {
  const color = getTuiStatusColor(props.status);
  return (
    <Box
      flexDirection="column"
      backgroundColor={props.focused ? tuiTheme.colors.selectionBackground : undefined}
      paddingX={1}
    >
      <Box>
        <Box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
          <Text bold={props.focused} wrap="truncate-end">
            {props.focused ? '›' : ' '} {props.name}
          </Text>
        </Box>
        <Box flexShrink={0} marginLeft={1}>
          <Text color={tuiTheme.colors.muted} wrap="truncate-end">{props.sourceLabel}</Text>
        </Box>
        <Box flexShrink={0} marginLeft={1}>
          <Text color={color} wrap="truncate-end">{props.statusLabel}</Text>
        </Box>
      </Box>
      <Text color={tuiTheme.colors.muted} wrap="truncate-end">  {props.description}</Text>
      {props.attention
        ? <Text color={tuiTheme.statusColors.warning} wrap="truncate-end">  ! {props.attention}</Text>
        : null}
      <Text color={tuiTheme.colors.muted} wrap="truncate-end">  {props.placementSummary}</Text>
    </Box>
  );
}

export function SectionRow(props: InteractiveRowProps): React.JSX.Element {
  return <FocusRow {...props} />;
}

export function ToggleRow(props: SelectableRowProps): React.JSX.Element {
  return <FocusRow {...props} marker={props.selected ? '◆' : '◇'} />;
}

export function ChoiceRow(props: SelectableRowProps): React.JSX.Element {
  return <FocusRow {...props} marker={props.selected ? '●' : '○'} />;
}

export function ActionRow(props: InteractiveRowProps): React.JSX.Element {
  return <FocusRow {...props} />;
}

export interface StaticRowProps {
  title: ReactNode;
  description?: ReactNode;
  meta?: ReactNode;
  status?: TuiStatus;
  compact?: boolean;
}

function StaticRowView(props: StaticRowProps & { marker?: string }): React.JSX.Element {
  const color = props.status ? getTuiStatusColor(props.status) : tuiTheme.colors.text;
  return (
    <Box flexDirection="column" paddingX={1}>
      <Box justifyContent="space-between">
        <Box flexGrow={1} flexShrink={1} overflow="hidden">
          <Text color={color} wrap="truncate-end">
            {props.marker ? `${props.marker} ` : ''}{props.title}
          </Text>
        </Box>
        {props.meta
          ? (
              <Box flexShrink={1} overflow="hidden" marginLeft={1}>
                <Text color={color} wrap="truncate-end">{props.meta}</Text>
              </Box>
            )
          : null}
      </Box>
      {props.description && !props.compact
        ? <Text color={tuiTheme.colors.muted} wrap="truncate-end">  {props.description}</Text>
        : null}
    </Box>
  );
}

export function StaticRow(props: StaticRowProps): React.JSX.Element {
  return <StaticRowView {...props} />;
}

export function ReviewChangeRow(props: StaticRowProps): React.JSX.Element {
  return <StaticRowView {...props} />;
}

export type ProgressState = 'pending' | 'active' | 'complete' | 'error';

const progressStateView: Record<ProgressState, { marker: string; status: TuiStatus }> = {
  pending: { marker: '○', status: 'muted' },
  active: { marker: '●', status: 'info' },
  complete: { marker: '✓', status: 'success' },
  error: { marker: '×', status: 'error' },
};

export function ProgressRow(props: Omit<StaticRowProps, 'status'> & {
  state: ProgressState;
}): React.JSX.Element {
  const view = progressStateView[props.state];
  return <StaticRowView {...props} marker={view.marker} status={view.status} />;
}

export function ResultRow(props: StaticRowProps & { status: TuiStatus }): React.JSX.Element {
  return <StaticRowView {...props} marker={statusSymbols[props.status]} />;
}
