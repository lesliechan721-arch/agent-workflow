import { Text } from 'ink';
import stringWidth from 'string-width';

import { EntityIdentityCard, type EntityCardLayout } from './entity-cards.js';
import { tuiTheme, type TuiStatus } from './theme.js';
import { wrapDisplayText } from './viewport.js';

export interface SourceDetailFacts {
  sourceId: string;
  primary: boolean;
  address: string;
  transport: string;
  versionPolicy: string;
  currentVersion?: string;
  candidateVersion?: string;
  pluginCount?: number;
  state: { label: string; status: TuiStatus };
  check: { label: string; time: string; status?: TuiStatus };
}

function sourceRows(facts: SourceDetailFacts, width: number) {
  const fields = [
    ...(stringWidth(facts.sourceId) > width - 6
      ? [{ key: 'sourceId', label: '来源', value: facts.sourceId }] : []),
    { key: 'address', label: '地址', value: facts.address },
    { key: 'transport', label: '下载', value: facts.transport },
    { key: 'policy', label: '版本策略', value: facts.versionPolicy },
    { key: 'currentVersion', label: '当前目录', value: facts.currentVersion ?? '未确认' },
    ...(facts.candidateVersion
      ? [{ key: 'candidateVersion', label: '候选目录', value: facts.candidateVersion }] : []),
    { key: 'state', label: '状态', value: `${facts.primary ? '[主来源] ' : ''}${facts.state.label}`, status: facts.state.status },
    { key: 'check', label: '本次检查', value: facts.check.label, status: facts.check.status },
    { key: 'checkTime', label: '检查时间', value: facts.check.time },
    { key: 'pluginCount', label: '插件数量', value: facts.pluginCount === undefined ? '未确认' : String(facts.pluginCount) },
  ];
  const valueWidth = Math.max(1, width - 4 - 9);
  const sections: EntityCardLayout['sections'] = [];
  const rows: Array<{ label: string; value: string; status?: TuiStatus }> = [];
  for (const field of fields) {
    const lines = wrapDisplayText(field.value, valueWidth);
    sections.push({ key: field.key, offset: rows.length, height: lines.length });
    rows.push(...lines.map((value, index) => ({
      label: index === 0 ? field.label : '', value, status: field.status,
    })));
  }
  return { rows, sections };
}

export function sourceDetailCardLayout(facts: SourceDetailFacts, width: number): EntityCardLayout {
  const { rows, sections } = sourceRows(facts, width);
  return { headerHeight: 2, factRows: rows.length, fullHeight: rows.length + 3, sections };
}

export function SourceDetailCard(props: {
  facts: SourceDetailFacts;
  width: number;
  focused?: boolean;
  lineOffset?: number;
  lineLimit?: number;
}): React.JSX.Element {
  const { rows } = sourceRows(props.facts, props.width);
  const offset = Math.min(Math.max(0, Math.floor(props.lineOffset ?? 0)), Math.max(0, rows.length - 1));
  const end = props.lineLimit === undefined ? rows.length
    : Math.min(rows.length, offset + Math.max(1, Math.floor(props.lineLimit)));
  return <EntityIdentityCard width={props.width} title={props.facts.sourceId} focused={props.focused}>
    {offset > 0 ? <Text color={tuiTheme.colors.muted}>↑ 前面还有信息</Text> : null}
    {rows.slice(offset, end).map((row, index) => <Text key={offset + index}>
      <Text color={tuiTheme.colors.muted}>{row.label}{' '.repeat(9 - stringWidth(row.label))}</Text>
      <Text color={row.status ? tuiTheme.statusColors[row.status] : tuiTheme.colors.text}>{row.value}</Text>
    </Text>)}
    {end < rows.length ? <Text color={tuiTheme.colors.muted}>↓ 后面还有信息</Text> : null}
  </EntityIdentityCard>;
}
