import { Box, Text } from 'ink';

import { contentRowBudget, wrapDisplayText } from './viewport.js';
import { tuiTheme } from './theme.js';

export interface ReaderPage {
  text: string;
  lines: string[];
  page: number;
  pageCount: number;
  offset: number;
  hasPrevious: boolean;
  hasNext: boolean;
}

function positiveInteger(value: number): number {
  return Math.max(1, Math.floor(Number.isFinite(value) ? value : 1));
}

export function paginateWrappedRows(options: {
  lines: string[];
  rows: number;
  page?: number;
}): Omit<ReaderPage, 'text'> {
  const rows = positiveInteger(options.rows);
  const pageCount = Math.max(1, Math.ceil(options.lines.length / rows));
  const page = Math.min(pageCount, positiveInteger(options.page ?? 1));
  const offset = (page - 1) * rows;
  return {
    lines: options.lines.slice(offset, offset + rows),
    page,
    pageCount,
    offset,
    hasPrevious: page > 1,
    hasNext: page < pageCount,
  };
}

export function readerPage(options: {
  text: string;
  columns: number;
  rows: number;
  page?: number;
}): ReaderPage {
  return {
    text: options.text,
    ...paginateWrappedRows({
      lines: wrapDisplayText(options.text, options.columns),
      rows: options.rows,
      page: options.page,
    }),
  };
}

export function readerBodyRows(options: {
  terminalRows: number;
  description?: boolean;
  compact?: boolean;
  staticRows?: number;
}): number {
  return Math.max(1, contentRowBudget({
    terminalRows: options.terminalRows,
    description: options.description ?? false,
    compact: options.compact ?? false,
    staticRows: options.staticRows,
  }) - 1);
}

export function Pager(props: {
  page: number;
  pageCount: number;
  columns?: number;
}): React.JSX.Element {
  return <Box width={props.columns} justifyContent="space-between" height={1} overflow="hidden">
    <Text color={props.page > 1 ? tuiTheme.colors.text : tuiTheme.colors.muted}>← 上一页</Text>
    <Text color={tuiTheme.colors.muted}>{props.page} / {props.pageCount}</Text>
    <Text color={props.page < props.pageCount ? tuiTheme.colors.text : tuiTheme.colors.muted}>下一页 →</Text>
  </Box>;
}

export function Reader(props: {
  text: string;
  columns: number;
  rows: number;
  page?: number;
}): React.JSX.Element {
  const page = readerPage(props);
  return <Box flexDirection="column" width={props.columns}>
    {page.lines.map((line, index) => <Text key={page.offset + index}>{line}</Text>)}
    <Pager page={page.page} pageCount={page.pageCount} columns={props.columns} />
  </Box>;
}
