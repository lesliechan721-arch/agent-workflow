import { Box, Text } from 'ink';
import stringWidth from 'string-width';

import type { UnifiedDependencyGraphProjection, UnifiedDependencyGraphRow } from './dependency-graph.js';
import { tuiTheme } from './theme.js';
import { rowViewport, type RowViewport } from './viewport.js';

export interface DependencyGraphViewRow {
  id: string;
  node: UnifiedDependencyGraphRow;
  section?: string;
  beforeLines: string[];
  tree: string;
  edge?: string;
  edgeVerified: boolean;
  edgeTarget?: string;
  label: string;
  padding: string;
  junction?: string;
  reference?: string;
  hidden?: string;
  health: string;
}

export interface DependencyGraphViewLayout {
  rows: DependencyGraphViewRow[];
  visibleRows: DependencyGraphViewRow[];
  focusRowId: string;
  focusIndex: number;
  scrollAnchorRowId: string;
  viewport: RowViewport;
}

export function dependencyGraphViewRowId(row: UnifiedDependencyGraphRow): string {
  return `${row.branch}:${row.id}`;
}

function fit(value: string, columns: number): string {
  if (stringWidth(value) <= columns) return value;
  let result = '';
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value)) {
    if (stringWidth(result + segment) > columns - 1) break;
    result += segment;
  }
  return `${result}…`;
}

function nodeHealth(row: UnifiedDependencyGraphRow): string {
  switch (row.nodeState) {
    case 'ready': return '✓ 可用';
    case 'missing': return '○ 未安装';
    case 'needsAttention': return '! 需处理';
    case 'unavailable': return '! 不可用';
    case 'unknown': return '? 未确认';
  }
}

function graphLine(
  row: UnifiedDependencyGraphRow,
  columns: number,
  junctionColumn: number,
  directIncomingIndex: number,
  parentLabel?: string,
  rootPluginId?: string,
): Omit<DependencyGraphViewRow, 'id' | 'node' | 'section' | 'beforeLines'> {
  const ancestors = row.ancestorHasNextSibling.slice(1);
  const indent = row.depth > 4 ? `…${row.depth} `
    : ancestors.map((hasNext) => hasNext ? '│  ' : '   ').join('');
  const edgeVerified = (row.edge?.availablePlacementReferences.length ?? 0) > 0;
  const edge = row.branch === 'root' ? undefined : edgeVerified ? '━━▶' : '┄┄▷';
  const branch = row.lastChild ? '└' : '├';
  const tree = row.branch === 'root' ? '◆ ' : `${indent}${branch}─ `;
  const isRootReference = row.branch !== 'root' && row.pluginId === rootPluginId;
  const reference = row.sharedWithRowId && !isRootReference ? ' ↩ 引用' : undefined;
  const hidden = row.hiddenDescendantCount > 0 ? ` [+${row.hiddenDescendantCount}]` : undefined;
  const health = row.branch === 'root' ? `当前 · ${nodeHealth(row)}` : nodeHealth(row);
  const healthWidth = stringWidth(` [${health}]`);
  const leftIndent = row.branch === 'dependents' ? '' : ' '.repeat(junctionColumn - 2);
  const edgeTarget = row.branch === 'dependents' && row.depth > 1 && parentLabel
    ? ` ${fit(parentLabel, 4)}` : undefined;
  const labelWidth = row.branch === 'dependents'
    ? Math.max(1, junctionColumn - 2 - stringWidth(tree) - stringWidth(edge ?? '')
      - stringWidth(edgeTarget ?? ''))
    : Math.max(1, columns - 2 - stringWidth(leftIndent) - stringWidth(tree)
      - (row.branch === 'dependencies' ? stringWidth(edge ?? '') + 1 : 0)
      - stringWidth(reference ?? '') - stringWidth(hidden ?? '') - healthWidth);
  const label = fit(isRootReference ? '↩当前' : row.label, labelWidth);
  const padding = row.branch === 'dependents'
    ? ' '.repeat(Math.max(0, labelWidth - stringWidth(label))) : '';
  return {
    tree: `${leftIndent}${tree}`,
    ...(edge ? { edge } : {}),
    edgeVerified,
    ...(edgeTarget ? { edgeTarget } : {}),
    label,
    padding,
    ...(row.branch === 'dependents'
      ? { junction: row.depth > 1 ? '│' : directIncomingIndex === 0 ? '┐' : '┤' } : {}),
    ...(reference ? { reference } : {}),
    ...(hidden ? { hidden } : {}),
    health,
  };
}

function nodeHealthColor(row: UnifiedDependencyGraphRow): string {
  if (row.nodeState === 'ready') return tuiTheme.roles.success;
  if (row.nodeState === 'needsAttention') return tuiTheme.roles.warning;
  if (row.nodeState === 'unavailable' || row.nodeState === 'missing') return tuiTheme.roles.error;
  return tuiTheme.roles.unknown;
}

export function projectDependencyGraphView(
  projection: UnifiedDependencyGraphProjection,
  options: {
    columns: number;
    rowBudget: number;
    focusRowId?: string;
    scrollAnchorRowId?: string;
  },
): DependencyGraphViewLayout {
  const ordered = [
    ...projection.rows.filter((row) => row.branch === 'dependents'),
    ...projection.rows.filter((row) => row.branch === 'root'),
    ...projection.rows.filter((row) => row.branch === 'dependencies'),
  ];
  const incomingCount = ordered.filter((row) => row.branch === 'dependents').length;
  const outgoingCount = ordered.filter((row) => row.branch === 'dependencies').length;
  const junctionColumn = Math.min(30, Math.max(18, Math.floor(options.columns * 0.45)));
  const labels = new Map(projection.rows.map((row) => [`${row.branch}:${row.id}`, row.label]));
  let directIncomingCount = 0;
  const rows = ordered.map((node, index): DependencyGraphViewRow => ({
    id: dependencyGraphViewRowId(node),
    node,
    ...(index === 0 && node.branch === 'dependents'
      ? { section: '使用它的插件 → 当前插件' }
      : index === 0 && node.branch === 'root' ? { section: '当前插件' } : {}),
    beforeLines: node.branch === 'root' && incomingCount > 0
      ? [`${' '.repeat(junctionColumn)}│`, `${' '.repeat(junctionColumn)}▼ 需要`]
      : node.branch === 'dependencies' && ordered[index - 1]?.branch === 'root' && outgoingCount > 0
        ? [`${' '.repeat(junctionColumn)}│`, `${' '.repeat(junctionColumn)}▼ 需要`]
        : [],
    ...graphLine(node, Math.max(12, options.columns), junctionColumn,
      node.branch === 'dependents' && node.depth === 1 ? directIncomingCount++ : directIncomingCount,
      node.parentRowId ? labels.get(`${node.branch}:${node.parentRowId}`) : undefined,
      projection.root.pluginId),
  }));
  const requestedFocus = rows.findIndex((row) => row.id === options.focusRowId);
  const rootIndex = rows.findIndex((row) => row.node.branch === 'root');
  const focus = requestedFocus >= 0 ? requestedFocus : Math.max(0, rootIndex);
  const anchor = rows.findIndex((row) => row.id === options.scrollAnchorRowId);
  const viewport = rowViewport({
    rowHeights: rows.map((row) => 1 + Number(Boolean(row.section)) + row.beforeLines.length),
    focus,
    requestedOffset: anchor >= 0 ? anchor : 0,
    rowBudget: Math.max(1, options.rowBudget),
  });
  return {
    rows,
    visibleRows: rows.slice(viewport.offset, viewport.offset + viewport.limit),
    focusRowId: rows[focus]?.id ?? '',
    focusIndex: focus,
    scrollAnchorRowId: rows[viewport.offset]?.id ?? '',
    viewport,
  };
}

export function DependencyGraphView(props: {
  projection: UnifiedDependencyGraphProjection;
  columns: number;
  rowBudget: number;
  focusRowId?: string;
  scrollAnchorRowId?: string;
}): React.JSX.Element {
  const layout = projectDependencyGraphView(props.projection, props);
  return <Box flexDirection="column" width={props.columns} overflow="hidden">
    {layout.visibleRows.map((row) => <Box key={row.id} flexDirection="column">
      {row.section ? <Text color={tuiTheme.colors.muted}>{row.section}</Text> : null}
      {row.beforeLines.map((line, index) => <Text key={`connector:${index}`} color={tuiTheme.colors.muted}>{line}</Text>)}
      <Text backgroundColor={row.id === layout.focusRowId ? tuiTheme.colors.selectionBackground : undefined}
        wrap="truncate-end">
        <Text color={row.id === layout.focusRowId ? tuiTheme.roles.focus : tuiTheme.colors.muted}>
          {row.id === layout.focusRowId ? '› ' : '  '}
        </Text>
        <Text color={tuiTheme.colors.muted}>{row.tree}</Text>
        {row.node.branch === 'dependencies' && row.edge
          ? <Text color={row.edgeVerified ? tuiTheme.colors.accent : tuiTheme.colors.muted}>{row.edge} </Text>
          : null}
        <Text color={tuiTheme.colors.text} bold={row.node.branch === 'root'}>{row.label}</Text>
        {row.node.branch === 'dependents' && row.edge
          ? <Text color={row.edgeVerified ? tuiTheme.colors.accent : tuiTheme.colors.muted}>
              {row.padding}{row.edge}{row.edgeTarget}{row.junction}
            </Text>
          : null}
        {row.reference ? <Text color={tuiTheme.colors.muted}>{row.reference}</Text> : null}
        {row.hidden ? <Text color={tuiTheme.colors.muted}>{row.hidden}</Text> : null}
        <Text color={nodeHealthColor(row.node)}> [{row.health}]</Text>
      </Text>
    </Box>)}
  </Box>;
}
