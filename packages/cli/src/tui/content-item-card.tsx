import { Box, Text } from 'ink';
import stringWidth from 'string-width';

import type { PluginContentItem, PluginContentType } from './plugin-content.js';
import { ObjectCardFrame } from './components.js';
import { type EntityCardLayout, entityCardWindowHeight } from './entity-cards.js';
import { tuiTheme } from './theme.js';
import { wrapDisplayText } from './viewport.js';

export const contentTypeLabels: Record<PluginContentType, string> = {
  skill: 'Skill', agent: 'Agent', role: '角色', instruction: '指令', permission: '权限',
  hook: 'Hook', command: '命令', mcpServer: 'MCP Server', app: 'App',
};

type ContentLine = { text: string; kind: 'fact' | 'description' | 'issue' };

export function contentItemHasReader(item: PluginContentItem, width: number): boolean {
  const titleWidth = Math.max(1, width - 11 - stringWidth(contentTypeLabels[item.type]));
  return Boolean(item.issue) || stringWidth(item.name) > titleWidth
    || Boolean(item.description && wrapDisplayText(item.description, Math.max(1, width - 4)).length > 1);
}

function contentLines(item: PluginContentItem, width: number): ContentLine[] {
  const columns = Math.max(1, width - 4);
  const lines: ContentLine[] = [];
  const add = (text: string, kind: ContentLine['kind']): void => {
    for (const part of wrapDisplayText(text, columns)) lines.push({ text: part, kind });
  };
  if (item.descriptionState !== 'issue' && item.description) {
    const wrapped = wrapDisplayText(item.description, columns);
    add(wrapped.length > 1
      ? `${wrapDisplayText(item.description, Math.max(1, columns - 1))[0]}…`
      : wrapped[0]!, 'description');
  }
  add(item.tools.length ? item.tools.map((tool) => `[${tool}]`).join(' ') : '[工具未确认]', 'fact');
  if (item.issue) {
    add('! 简介读取问题 · Enter 查看原因', 'issue');
  }
  return lines;
}

export function contentItemCardLayout(item: PluginContentItem, width: number): EntityCardLayout {
  const factRows = contentLines(item, width).length;
  return { headerHeight: 1, factRows, fullHeight: factRows + 2,
    sections: [{ key: item.id, offset: 0, height: factRows }] };
}

export function ContentItemCard(props: {
  item: PluginContentItem;
  width: number;
  focused?: boolean;
  lineOffset?: number;
  lineLimit?: number;
}): React.JSX.Element {
  const lines = contentLines(props.item, props.width);
  const offset = Math.min(Math.max(0, props.lineOffset ?? 0), Math.max(0, lines.length - 1));
  const visible = lines.slice(offset, props.lineLimit === undefined
    ? undefined : offset + Math.max(1, props.lineLimit));
  return <ObjectCardFrame width={props.width} title={props.item.name}
    headerMeta={contentTypeLabels[props.item.type]} focused={props.focused}>
    {offset > 0 ? <Text color={tuiTheme.colors.muted}>↑ 前面还有信息</Text> : null}
    {visible.map((line, index) => <Box key={`${offset}:${index}`}>
      <Text color={line.kind === 'issue' ? tuiTheme.statusColors.warning
        : line.kind === 'description' ? tuiTheme.colors.muted : tuiTheme.colors.text}>
        {line.text}
      </Text>
    </Box>)}
    {offset + visible.length < lines.length
      ? <Text color={tuiTheme.colors.muted}>↓ 后面还有信息</Text> : null}
  </ObjectCardFrame>;
}

export { entityCardWindowHeight as contentItemCardWindowHeight };
