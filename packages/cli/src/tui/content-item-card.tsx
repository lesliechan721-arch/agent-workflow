import { Box, Text } from 'ink';
import stringWidth from 'string-width';

import type { PluginContentItem, PluginContentType } from './plugin-content.js';
import { EntityIdentityCard, type EntityCardLayout, entityCardWindowHeight } from './entity-cards.js';
import { tuiTheme } from './theme.js';
import { wrapDisplayText } from './viewport.js';

export const contentTypeLabels: Record<PluginContentType, string> = {
  skill: 'Skill', agent: 'Agent', role: '角色', instruction: '指令', permission: '权限',
  hook: 'Hook', command: '命令', mcpServer: 'MCP Server', app: 'App',
};

type ContentLine = { text: string; kind: 'fact' | 'description' | 'issue' };

function contentLines(item: PluginContentItem, width: number): ContentLine[] {
  const columns = Math.max(1, width - 4);
  const lines: ContentLine[] = [];
  const add = (text: string, kind: ContentLine['kind']): void => {
    for (const part of wrapDisplayText(text, columns)) lines.push({ text: part, kind });
  };
  if (stringWidth(item.name) > columns) add(`名称 ${item.name}`, 'fact');
  add(`类型 ${contentTypeLabels[item.type]}`, 'fact');
  add(`适用工具 ${item.tools.length ? item.tools.join('、') : '未确认'}`, 'fact');
  if (item.descriptionState !== 'issue' && item.description) add(item.description, 'description');
  if (item.issue) {
    add('简介读取问题', 'issue');
    add(item.issue.message, 'issue');
  }
  return lines;
}

export function contentItemCardLayout(item: PluginContentItem, width: number): EntityCardLayout {
  const factRows = contentLines(item, width).length;
  return { headerHeight: 2, factRows, fullHeight: factRows + 3,
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
  return <EntityIdentityCard width={props.width} title={props.item.name} focused={props.focused}>
    {offset > 0 ? <Text color={tuiTheme.colors.muted}>↑ 前面还有信息</Text> : null}
    {visible.map((line, index) => <Box key={`${offset}:${index}`}>
      <Text color={line.kind === 'issue' ? tuiTheme.statusColors.warning
        : line.kind === 'description' ? tuiTheme.colors.muted : tuiTheme.colors.text}>
        {line.text}
      </Text>
    </Box>)}
    {offset + visible.length < lines.length
      ? <Text color={tuiTheme.colors.muted}>↓ 后面还有信息</Text> : null}
  </EntityIdentityCard>;
}

export { entityCardWindowHeight as contentItemCardWindowHeight };
