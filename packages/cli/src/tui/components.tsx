import { Box, Text, useWindowSize } from 'ink';
import type { ReactNode } from 'react';
import stringWidth from 'string-width';

import {
  safeDiagnosticCode,
  sanitizeDiagnosticCause,
  sanitizeDiagnosticText,
  type DiagnosticSummaryViewModel,
} from './diagnostics.js';
import { resolveTuiSizePolicy, type TuiSizePolicy } from './layout.js';
import { getTuiStatusColor, tuiTheme, type TuiStatus } from './theme.js';
import { Pager, paginateWrappedRows } from './reader.js';
import { wrapDisplayText } from './viewport.js';

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

export function ContentViewport(props: {
  children: ReactNode;
}): React.JSX.Element {
  return <Box flexDirection="column" flexGrow={1} overflow="hidden">{props.children}</Box>;
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
  const headerWidth = policy.columns - 2;
  const contextWidth = props.context
    ? Math.min(stringWidth(props.context), headerWidth - 13)
    : 0;

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
        <Box width={headerWidth - (contextWidth ? contextWidth + 1 : 0)} flexShrink={0}>
          <Text bold color={tuiTheme.colors.accent} wrap="truncate-end">
            AW{props.breadcrumb ? ` / ${props.breadcrumb}` : ''}
          </Text>
        </Box>
        {props.context
          ? <Box width={contextWidth} flexShrink={0}>
              <Text color={tuiTheme.colors.muted} wrap="truncate-end">{props.context}</Text>
            </Box>
          : null}
      </Box>
      <Box flexDirection="column" flexGrow={1} overflow="hidden" paddingX={1}>
        {props.title ? <Text bold color={tuiTheme.colors.text}>{props.title}</Text> : null}
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

export type StatusBadgeSymbol = '✓' | '○' | '!' | '↑' | '?';

export interface StatusBadgeItem {
  key: string;
  label: ReactNode;
  symbol: StatusBadgeSymbol;
  status?: TuiStatus;
}

export function StatusBadge(props: {
  items?: StatusBadgeItem[];
  children?: ReactNode;
}): React.JSX.Element {
  return (
    <Box>
      {props.items?.map((item) => (
        <Box key={item.key} marginRight={1} flexShrink={0}>
          <Text color={getTuiStatusColor(item.status ?? 'muted')}>[{item.symbol} {item.label}]</Text>
        </Box>
      ))}
      {props.children}
    </Box>
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
  sourcePolicy: '版本策略',
  freshness: '检查时间',
  candidate: '待检查版本',
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

export function diagnosticDetailLines(
  diagnostic: DiagnosticSummaryViewModel,
  width: number,
): string[] {
  const lineWidth = Math.max(1, Math.floor(Number.isFinite(width) ? width : 1));
  return diagnosticDetailRows(diagnostic).flatMap((row) => {
    const prefix = `${row.label}: `;
    const valueWidth = Math.max(1, lineWidth - stringWidth(prefix));
    return wrapDisplayText(row.value, valueWidth).map((chunk) => `${prefix}${chunk}`);
  });
}

export function diagnosticDetailText(diagnostic: DiagnosticSummaryViewModel): string {
  return diagnosticDetailRows(diagnostic).map((row) => `${row.label}: ${row.value}`).join('\n');
}

export function diagnosticDetailRowCount(diagnostic: DiagnosticSummaryViewModel): number {
  return diagnosticDetailRows(diagnostic).length;
}

export function DiagnosticSummary(props: {
  diagnostic: DiagnosticSummaryViewModel;
  technical?: boolean;
  columns?: number;
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
  const rows = diagnosticDetailLines(props.diagnostic, (props.columns ?? 80) - 6);
  const limit = props.limit ?? Math.max(1, rows.length);
  const requestedOffset = Math.max(0, Math.floor(Number.isFinite(props.offset) ? props.offset ?? 0 : 0));
  const page = paginateWrappedRows({ lines: rows, rows: limit,
    page: Math.floor(requestedOffset / Math.max(1, limit)) + 1 });

  return <Box flexDirection="column">
    <Text color={tuiTheme.colors.muted}>下面的信息已脱敏，可用于排查或提交 issue。</Text>
    <TechnicalDetails label="脱敏诊断" compact>
      {page.lines.map((line, index) => <Box key={page.offset + index} paddingX={1}>
        <Text>{line}</Text>
      </Box>)}
      {props.limit !== undefined
        ? <Pager page={page.page} pageCount={page.pageCount} columns={(props.columns ?? 80) - 4} />
        : null}
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
    : tuiTheme.colors.text;
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
        {props.status || props.meta
          ? (
              <Box flexShrink={1} overflow="hidden" marginLeft={1}>
                {props.status ? <Text color={props.disabled ? tuiTheme.colors.muted : getTuiStatusColor(props.status)}
                  wrap="truncate-end">
                  {statusSymbols[props.status]}{props.meta ? ` ${props.meta}` : ''}
                </Text> : null}
                {props.meta && !props.status ? <Text color={props.disabled ? tuiTheme.colors.muted : tuiTheme.colors.text}
                  wrap="truncate-end">{props.meta}</Text> : null}
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
  width?: number;
  name: ReactNode;
  sourceLabel: ReactNode;
  description: ReactNode;
  attention?: ReactNode;
  placementSummary?: ReactNode;
  statusLabel?: ReactNode;
  status?: TuiStatus;
  tags?: ReactNode;
  focused?: boolean;
  anchored?: boolean;
}

function ObjectCardFrame(props: {
  width: number;
  title: ReactNode;
  children: ReactNode;
  focused?: boolean;
  anchored?: boolean;
  muted?: boolean;
  compact?: boolean;
}): React.JSX.Element {
  const borderColor = props.focused ? tuiTheme.colors.accent : tuiTheme.colors.border;
  const backgroundColor = props.focused
    ? tuiTheme.colors.selectionBackground
    : props.muted ? tuiTheme.colors.background : undefined;
  return <Box width={props.width} flexDirection="column" flexShrink={0} backgroundColor={backgroundColor}>
    <Box height={1} flexShrink={0} overflow="hidden">
      <Text color={borderColor}>╭─ </Text>
      <Box maxWidth={Math.max(1, props.width - 6)} flexShrink={0} overflow="hidden"
        backgroundColor={tuiTheme.colors.background}>
        <Text bold color={props.focused ? tuiTheme.colors.accent : props.muted ? tuiTheme.colors.muted : tuiTheme.colors.text}
          wrap="truncate-end">
          {props.focused ? '› ' : props.anchored ? '· ' : ''}{props.title}
        </Text>
      </Box>
      <Text color={borderColor}> </Text>
      <Box flexGrow={1} flexShrink={1} minWidth={0} height={1} borderStyle="single"
        borderColor={borderColor} borderTop={false} borderLeft={false} borderRight={false} />
      <Text color={borderColor}>╮</Text>
    </Box>
    <Box flexDirection="column" borderStyle="round" borderTop={false}
      borderColor={borderColor} paddingX={props.compact ? 0 : 1}>
      {props.children}
    </Box>
  </Box>;
}

export function KeyCap(props: { children: ReactNode }): React.JSX.Element {
  return <Text bold color={tuiTheme.roles.keycap} backgroundColor={tuiTheme.colors.borderStrong}>[{props.children}]</Text>;
}

export function HomeNavTile(props: {
  width: number;
  title: string;
  focused: boolean;
  children: ReactNode;
}): React.JSX.Element {
  return <ObjectCardFrame {...props} compact>{props.children}</ObjectCardFrame>;
}

export interface ConfigTileProps {
  width: number;
  title: string;
  value: string;
  source: string;
  pending?: string;
  invalid?: boolean;
  focused?: boolean;
}

export function configTileHeight(props: Pick<ConfigTileProps, 'width' | 'value' | 'pending'>): number {
  return 2 + cardSummaryLines(props.value, Math.max(1, props.width - 2), 2).length + (props.pending ? 1 : 0);
}

export function ConfigTile(props: ConfigTileProps): React.JSX.Element {
  return <ObjectCardFrame width={props.width} focused={props.focused} compact
    title={<Text>{props.title}{props.source ? <Text color={tuiTheme.roles.secondary}> [{props.source}]</Text> : null}</Text>}>
    {cardSummaryLines(props.invalid ? '需修正' : props.value, Math.max(1, props.width - 2), 2).map((line, index) =>
      <Text key={index} bold color={props.invalid ? tuiTheme.roles.error : tuiTheme.roles.primaryValue}>{line}</Text>)}
    {props.pending ? <Text color={tuiTheme.roles.change} wrap="truncate-end">● {props.pending}</Text> : null}
  </ObjectCardFrame>;
}

function ObjectCardFooter(props: { tags?: ReactNode; sourceLabel?: ReactNode }): React.JSX.Element {
  return <Box height={1} overflow="hidden" justifyContent="space-between">
    {props.tags ? <Box flexShrink={0}>{props.tags}</Box> : null}
    {props.sourceLabel ? <Box minWidth={0} flexGrow={1} flexShrink={1} justifyContent="flex-end">
      <Text color={tuiTheme.colors.muted} wrap="truncate-end">{props.sourceLabel}</Text>
    </Box> : null}
  </Box>;
}

function cardSummaryLines(description: string, width: number, maxRows?: number): string[] {
  const lines = description ? wrapDisplayText(description, width) : [];
  if (maxRows === undefined || lines.length <= maxRows) return lines;
  const visible = lines.slice(0, Math.max(1, maxRows));
  const last = visible.length - 1;
  visible[last] = `${wrapDisplayText(visible[last]!, Math.max(1, width - 1))[0]}…`;
  return visible;
}

export function pluginListRowLayout(options: {
  width: number;
  description: string;
  attention?: string;
  placementSummary?: string;
  sourceLabel?: ReactNode;
  hasTags?: boolean;
  statusLabel?: ReactNode;
}): {
  descriptionLines: string[];
  attentionLines: string[];
  placementLines: string[];
  height: number;
} {
  const contentWidth = Math.max(1, options.width - 4);
  const descriptionLines = cardSummaryLines(options.description, contentWidth, 2);
  const attentionLines = options.attention ? cardSummaryLines(`! ${options.attention}`, contentWidth, 2) : [];
  const placementLines = options.placementSummary ? wrapDisplayText(options.placementSummary, contentWidth) : [];
  return {
    descriptionLines,
    attentionLines,
    placementLines,
    height: 2 + descriptionLines.length + attentionLines.length + placementLines.length
      + (options.hasTags || options.statusLabel || options.sourceLabel ? 1 : 0),
  };
}

export function PluginListRow(props: PluginListRowProps): React.JSX.Element {
  const windowSize = useWindowSize();
  const width = props.width ?? windowSize.columns;
  const color = props.status ? getTuiStatusColor(props.status) : tuiTheme.colors.text;
  const layout = pluginListRowLayout({
    ...props,
    width,
    description: typeof props.description === 'string' ? props.description : '',
    attention: typeof props.attention === 'string' ? props.attention : undefined,
    placementSummary: typeof props.placementSummary === 'string' ? props.placementSummary : undefined,
    hasTags: Boolean(props.tags),
  });
  return (
    <ObjectCardFrame width={width} title={props.name} focused={props.focused} anchored={props.anchored}>
      {typeof props.description === 'string'
        ? layout.descriptionLines.map((line, index) => <Text key={`description:${index}`} color={tuiTheme.colors.muted}>{line}</Text>)
        : <Text color={tuiTheme.colors.muted}>{props.description}</Text>}
      {typeof props.attention === 'string'
        ? layout.attentionLines.map((line, index) => <Text key={`attention:${index}`} color={tuiTheme.statusColors.warning}>{line}</Text>)
        : props.attention ? <Text color={tuiTheme.statusColors.warning}>! {props.attention}</Text> : null}
      {typeof props.placementSummary === 'string'
        ? layout.placementLines.map((line, index) => <Text key={`placement:${index}`} color={tuiTheme.colors.muted}>{line}</Text>)
        : props.placementSummary ? <Text color={tuiTheme.colors.muted}>{props.placementSummary}</Text> : null}
      {props.tags || props.statusLabel || props.sourceLabel ? <ObjectCardFooter
        tags={props.tags ?? (props.statusLabel ? <Text color={color}>{props.statusLabel}</Text> : undefined)}
        sourceLabel={props.sourceLabel} /> : null}
    </ObjectCardFrame>
  );
}

export interface ObjectCardRowLayoutOptions {
  width: number;
  description: string;
  maxDescriptionRows?: number;
  meta?: string;
  sourceLabel?: ReactNode;
  hasTags?: boolean;
  compact?: boolean;
}

export interface ObjectCardRowLayout {
  descriptionLines: string[];
  metaLines: string[];
  height: number;
}

export function objectCardRowLayout(options: ObjectCardRowLayoutOptions): ObjectCardRowLayout {
  const cardWidth = Math.max(1, Math.floor(Number.isFinite(options.width) ? options.width : 1));
  const horizontalPadding = options.compact ? 0 : 2;
  const contentWidth = Math.max(1, cardWidth - 2 - horizontalPadding);
  const descriptionLines = cardSummaryLines(options.description, contentWidth, options.maxDescriptionRows);
  const metaLines = options.meta ? wrapDisplayText(options.meta, contentWidth) : [];
  return {
    descriptionLines,
    metaLines,
    height: 2
      + descriptionLines.length
      + metaLines.length
      + (options.hasTags || options.sourceLabel ? 1 : 0),
  };
}

export function ObjectCardRow(props: {
  width: number;
  title: ReactNode;
  description: string;
  maxDescriptionRows?: number;
  meta?: string;
  sourceLabel?: ReactNode;
  tags?: ReactNode;
  status?: TuiStatus;
  focused?: boolean;
  anchored?: boolean;
  muted?: boolean;
  compact?: boolean;
}): React.JSX.Element {
  const layout = objectCardRowLayout({
    width: props.width,
    description: props.description,
    maxDescriptionRows: props.maxDescriptionRows,
    meta: props.meta,
    sourceLabel: props.sourceLabel,
    hasTags: Boolean(props.tags),
    compact: props.compact,
  });
  return (
    <ObjectCardFrame {...props} title={<Text>
      {props.status && !props.tags
        ? <Text color={getTuiStatusColor(props.status)}>{statusSymbols[props.status]} </Text>
        : null}{props.title}
    </Text>}>
      {layout.descriptionLines.map((line, index) => (
        <Text key={`description:${index}`} color={tuiTheme.colors.muted} wrap="truncate-end">{line}</Text>
      ))}
      {layout.metaLines.map((line, index) => (
        <Text key={`meta:${index}`} color={tuiTheme.colors.muted} wrap="truncate-end">{line}</Text>
      ))}
      {props.tags || props.sourceLabel ? <ObjectCardFooter tags={props.tags} sourceLabel={props.sourceLabel} /> : null}
    </ObjectCardFrame>
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
  value?: ReactNode;
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
      {props.value !== undefined && props.value !== null
        ? <Text color={color} wrap={props.compact ? 'truncate-end' : 'wrap'}>  {props.value}</Text>
        : null}
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
