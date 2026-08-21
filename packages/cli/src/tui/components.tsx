import { Box, Text, useWindowSize } from 'ink';
import type { ReactNode } from 'react';

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
    <Box borderStyle="single" borderLeft={false} borderRight={false} borderBottom={false}>
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
    >
      <Text color={tuiTheme.statusColors.warning}>↔ {props.policy.message}</Text>
      <Text color={tuiTheme.colors.muted}>
        当前：{props.policy.columns} 列 × {props.policy.rows} 行。
      </Text>
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
      paddingX={1}
    >
      <Box justifyContent="space-between">
        <Text bold color={tuiTheme.colors.accent} wrap="truncate-end">
          AW{props.breadcrumb ? ` / ${props.breadcrumb}` : ''}
        </Text>
        {props.context
          ? <Text color={tuiTheme.colors.muted} wrap="truncate-end">{props.context}</Text>
          : null}
      </Box>
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        <Text bold>{props.title}</Text>
        {props.description
          ? <Text color={tuiTheme.colors.muted}>{props.description}</Text>
          : null}
        <Box flexDirection="column" flexGrow={1} overflow="hidden" marginTop={1}>
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
