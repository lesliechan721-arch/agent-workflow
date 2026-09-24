import { Box, Text, useWindowSize } from 'ink';
import type { ReactNode } from 'react';
import stringWidth from 'string-width';

import { KeyCap } from './components.js';
import { tuiTheme } from './theme.js';

export interface QueryHeaderProps {
  width?: number;
  tabs?: {
    label?: string;
    items: Array<{ id: string; label: string; count?: number }>;
    currentId: string;
  };
  search?: { value: string; input?: ReactNode; editing?: boolean; placeholder?: string };
  filter?: { label: string; count?: number; currentZero?: boolean };
  selection?: { total: number; hidden?: number };
}

function visibleTabs(tabs: NonNullable<QueryHeaderProps['tabs']>, available: number): string {
  const current = Math.max(0, tabs.items.findIndex((item) => item.id === tabs.currentId));
  const labels = tabs.items.map((item, index) => {
    const text = `${item.label}${item.count === undefined ? '' : ` ${item.count}`}`;
    return index === current ? `[${text}]` : text;
  });
  const chosen = new Set<number>([current]);
  for (let distance = 1; distance < labels.length; distance += 1) {
    for (const index of [current - distance, current + distance]) {
      if (index < 0 || index >= labels.length) continue;
      const candidate = [...chosen, index].sort((a, b) => a - b);
      if (stringWidth(candidate.map((entry) => labels[entry]).join('  ')) <= available) chosen.add(index);
    }
  }
  return [...chosen].sort((a, b) => a - b).map((index) => labels[index]).join('  ');
}

export function QueryHeader(props: QueryHeaderProps): React.JSX.Element | null {
  const windowSize = useWindowSize();
  const width = Math.max(1, props.width ?? windowSize.columns - 2);
  if (!props.tabs && !props.search && !props.filter && !props.selection) return null;
  const tabLabel = props.tabs?.label ?? '清单';
  const tabWidth = Math.max(1, width - stringWidth(`${tabLabel}  [←→] 切换`));

  return <Box flexDirection="column" width={width}>
    {props.tabs?.items.length ? <Box width={width} height={1} overflow="hidden">
      <Text color={tuiTheme.colors.muted}>{tabLabel} </Text>
      <Box width={tabWidth} flexShrink={0} overflow="hidden">
        <Text color={tuiTheme.colors.text} wrap="truncate-end">{visibleTabs(props.tabs, tabWidth)}</Text>
      </Box>
      <Box flexShrink={0}><Text> </Text><KeyCap>←→</KeyCap>
        <Text color={tuiTheme.colors.muted}> 切换</Text></Box>
    </Box> : null}
    {props.search ? <Box width={width} height={1} overflow="hidden">
      <Text color={tuiTheme.colors.muted}>搜索 </Text><KeyCap>/</KeyCap><Text> </Text>
      <Box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
        {props.search.input ?? <Text color={props.search.value ? tuiTheme.colors.text : tuiTheme.colors.muted}
          wrap="truncate-end">{props.search.value || props.search.placeholder || '名称或来源'}{props.search.editing ? '│' : ''}</Text>}
      </Box>
    </Box> : null}
    {props.filter ? <Box width={width} height={1} overflow="hidden">
      <Text color={tuiTheme.colors.muted}>筛选 </Text>
      <Text color={props.filter.currentZero ? tuiTheme.statusColors.warning : tuiTheme.colors.text} wrap="truncate-end">
        [{props.filter.label}{props.filter.count === undefined ? '' : ` ${props.filter.count}`}]
        {props.filter.currentZero ? ' 当前条件无匹配' : ''}
      </Text>
      <Text> </Text><KeyCap>f</KeyCap><Text color={tuiTheme.colors.muted}> 切换</Text>
    </Box> : null}
    {props.selection ? <Box width={width} height={1} overflow="hidden">
      <Text color={tuiTheme.colors.muted}>已选 </Text>
      <Text color={tuiTheme.colors.text}>{props.selection.total}</Text>
      {props.selection.hidden ? <Text color={tuiTheme.colors.muted}> · 隐藏已选 {props.selection.hidden}</Text> : null}
    </Box> : null}
  </Box>;
}
