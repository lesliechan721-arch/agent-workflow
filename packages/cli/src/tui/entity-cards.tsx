import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import stringWidth from 'string-width';

import { ObjectCardFrame } from './components.js';
import { agentLabel, platformLabel, scopeLabel } from './glossary.js';
import { Pager } from './reader.js';
import type { PluginDetailPlacement, PluginDetailSubject } from './plugin-detail.js';
import type { InventoryRoot as ProjectInventoryRoot, InventoryState as ProjectInventoryState,
  InventoryTarget as ProjectInventoryTarget } from './scoped-inventory.js';
import { tuiTheme, type TuiStatus } from './theme.js';
import { wrapDisplayText } from './viewport.js';

type CellRole = 'text' | 'muted' | 'platform' | 'status';
interface CardCell { text: string; role: CellRole; status?: TuiStatus }
interface CardLine { cells: CardCell[] }
type CardSection = { key: string; offset: number; height: number };

export interface EntityCardLayout {
  /** Full rendered height includes the fixed header, fact lines, and bottom border. */
  fullHeight: number;
  /** Fixed header rows; identity may be embedded in the top border. */
  headerHeight: number;
  factRows: number;
  horizontalPaging?: boolean;
  /** Each offset and height is measured in rendered fact lines. */
  sections: CardSection[];
}

function innerWidth(width: number): number {
  return Math.max(1, Math.floor(width) - 4);
}

function preview(value: string, width: number): string {
  if (stringWidth(value) <= width) return value;
  return `${wrapDisplayText(value, Math.max(1, width - 1))[0]}…`;
}

function identityWidths(sourceId: string | undefined, width: number) {
  const columns = innerWidth(width);
  const source = sourceId ? `[${sourceId}]` : '';
  const sourceWidth = source ? Math.min(stringWidth(source), Math.max(6, Math.floor(columns / 3))) : 0;
  return { titleWidth: Math.max(1, columns - sourceWidth - Number(Boolean(source)) - 2), sourceWidth };
}

function addFields(
  lines: CardLine[], sections: CardSection[], key: string, width: number, fields: CardCell[],
): void {
  const offset = lines.length;
  const columns = innerWidth(width);
  let cells: CardCell[] = [];
  let used = 0;
  const flush = (): void => {
    if (cells.length > 0) lines.push({ cells });
    cells = [];
    used = 0;
  };
  for (const field of fields) {
    for (const text of wrapDisplayText(field.text, columns)) {
      const gap = cells.length > 0 ? 1 : 0;
      if (used + gap + stringWidth(text) > columns) flush();
      cells.push({ ...field, text });
      used += (cells.length > 1 ? 1 : 0) + stringWidth(text);
    }
  }
  flush();
  sections.push({ key, offset, height: lines.length - offset });
}

const plain = (text: string): CardCell => ({ text, role: 'text' });
const muted = (text: string): CardCell => ({ text, role: 'muted' });
const statusCell = (label: string, status: TuiStatus, symbol: string): CardCell => ({
  text: `[${symbol} ${label}]`, role: 'status', status,
});

const projectStates: Record<ProjectInventoryState, { label: string; status: TuiStatus; symbol: string }> = {
  blocked: { label: '受阻', status: 'error', symbol: '!' },
  pending: { label: '待同步', status: 'warning', symbol: '↻' },
  unknown: { label: '未确认', status: 'muted', symbol: '?' },
  ready: { label: '可用', status: 'success', symbol: '✓' },
};

export type EntityPlacementFact = Pick<PluginDetailPlacement, 'platform' | 'agent' | 'delivery' | 'scope' | 'observation'
  | 'statusState' | 'projectState' | 'declared' | 'actual' | 'installedVersion' | 'expectedVersion'>
  & { shared: boolean };

function placementIdentity(fact: Pick<EntityPlacementFact, 'platform' | 'agent' | 'delivery' | 'scope'>): string {
  return [fact.agent ?? '', fact.delivery ?? '', fact.platform ?? '', fact.scope].join(':');
}

function placementHealth(fact: EntityPlacementFact) {
  if (fact.projectState === 'blocked' || fact.statusState === 'blocked') return projectStates.blocked;
  if (fact.statusState === 'orphaned') {
    return { label: '残留待处理', status: 'warning' as const, symbol: '!' };
  }
  if (fact.observation === 'unknown') return projectStates.unknown;
  if (fact.projectState) return projectStates[fact.projectState];
  if (fact.statusState === 'ready') return projectStates.ready;
  if (fact.statusState === 'needsSync') return projectStates.pending;
  if (fact.statusState === 'absent') {
    return { label: '未安装', status: 'muted' as const, symbol: '○' };
  }
  return projectStates.unknown;
}

function placementFields(fact: EntityPlacementFact): CardCell[] {
  const health = placementHealth(fact);
  const identity = fact.agent ? agentLabel(fact.agent)
    : fact.platform ? platformLabel(fact.platform) : '目标';
  return [
    { text: identity, role: 'platform' },
    muted(`[${scopeLabel(fact.scope)}]`),
    ...(fact.shared ? [muted('[共用个人安装]')] : []),
    ...(fact.declared && !fact.actual
      ? [muted(fact.scope === 'project' ? '[项目声明]' : '[使用声明]')] : []),
    ...(health.label === '未安装' ? [] : [plain(`安装版本 ${fact.installedVersion ?? '未确认'}`)]),
    statusCell(health.label, health.status, health.symbol),
  ];
}

function fromProjectTarget(
  target: ProjectInventoryTarget, detail?: PluginDetailPlacement,
  declared = false,
): EntityPlacementFact {
  return {
    platform: target.platform, agent: target.agent, delivery: target.delivery, scope: target.scope,
    shared: target.location === 'sharedUser',
    declared: detail?.declared ?? declared,
    actual: detail?.actual ?? false,
    observation: detail?.observation ?? (target.state === 'unknown' ? 'unknown' : 'known'),
    projectState: target.state,
    statusState: detail?.statusState,
    installedVersion: detail?.installedVersion ?? target.installedVersion,
  };
}

function addIdentityOverflow(
  lines: CardLine[], sections: CardSection[], subject: PluginDetailSubject, width: number,
): void {
  const sizes = identityWidths(subject.sourceId, width);
  if (stringWidth(subject.displayName) > sizes.titleWidth) {
    addFields(lines, sections, 'name', width, [muted('名称'), plain(subject.displayName)]);
  }
  if (stringWidth(`[${subject.sourceId}]`) > sizes.sourceWidth) {
    addFields(lines, sections, 'source', width, [muted('来源'), plain(subject.sourceId)]);
  }
}

function pluginFacts(subject: PluginDetailSubject, width: number) {
  const lines: CardLine[] = [];
  const sections: CardSection[] = [];
  addIdentityOverflow(lines, sections, subject, width);
  if (subject.description) addFields(lines, sections, 'description', width, [muted(subject.description)]);
  if (!subject.definitionAvailable) {
    addFields(lines, sections, 'definition', width,
      [statusCell('目录定义当前不可用', 'warning', '!')]);
  }
  addFields(lines, sections, 'catalogVersion', width,
    [muted('目录版本'), subject.catalogVersion ? plain(subject.catalogVersion) : muted('未确认')]);
  if (subject.savedConfigScopes.length > 0) {
    addFields(lines, sections, 'savedConfig', width,
      [muted('已保存设置'), plain(subject.savedConfigScopes.map(scopeLabel).join('、'))]);
  }
  for (const scope of ['user', 'project'] as const) {
    const declaration = subject.declarations[scope];
    const scopeName = scope === 'user' ? '个人清单' : '当前项目清单';
    const state = declaration.state === 'declared' ? '已声明'
      : declaration.state === 'not-declared' ? '未声明' : '未检查';
    addFields(lines, sections, `declaration:${scope}`, width,
      [muted(scopeName), statusCell(state,
        declaration.state === 'declared' ? 'success' : 'muted',
        declaration.state === 'declared' ? '✓' : declaration.state === 'not-declared' ? '○' : '?')]);
    if (declaration.state === 'declared') {
      addFields(lines, sections, `declaration:${scope}:targets`, width,
        [muted('本机工具'), plain(declaration.targets === 'empty' ? '未选择'
          : declaration.targets === 'selected' ? declaration.agents.map(agentLabel).join('、') : '未检查')]);
      if (declaration.sourceState && declaration.sourceState !== 'ready') {
        addFields(lines, sections, `declaration:${scope}:source`, width,
          [muted('来源状态'), plain(declaration.sourceState)]);
      }
    }
  }
  for (const placement of subject.placements) {
    const key = `placement:${placementIdentity(placement)}`;
    addFields(lines, sections, key, width,
      placementFields({ ...placement, shared: placement.sharedWithCurrentProject }));
    if (placement.declared && placement.expectedVersion) {
      addFields(lines, sections, `${key}:expectedVersion`, width,
        [muted('声明期望版本'), plain(placement.expectedVersion)]);
    }
  }
  if (subject.placements.length === 0) {
    addFields(lines, sections, 'placements', width,
      [muted('使用位置'), statusCell('未确认', 'muted', '?')]);
  }
  return { lines, sections };
}

function projectFacts(root: ProjectInventoryRoot, subject: PluginDetailSubject, width: number) {
  const lines: CardLine[] = [];
  const sections: CardSection[] = [];
  addIdentityOverflow(lines, sections, subject, width);
  const overall = projectStates[root.state];
  addFields(lines, sections, 'overall', width,
    [muted('总体状态'), statusCell(root.state === 'ready' ? '就绪' : overall.label,
      overall.status, overall.symbol)]);
  if (root.agentResults) {
    addFields(lines, sections, 'demand', width,
      [muted(root.scope === 'user' ? '个人需求' : '项目需求'), plain(root.pluginId)]);
    if (root.sourceState && root.sourceState !== 'ready') {
      addFields(lines, sections, 'sourceState', width,
        [muted('来源'), statusCell(root.sourceState, 'warning', '!')]);
    }
    for (const blocker of root.blockers ?? []) {
      addFields(lines, sections, `blocker:${blocker.code}`, width,
        [statusCell(blocker.code, 'warning', '!')]);
    }
    for (const target of root.agentResults) {
      const delivery = target.delivery?.kind === 'native'
        ? '原生' : target.delivery?.kind === 'agent-skills' ? 'Skills' : '无适用交付';
      const state: ProjectInventoryState = target.blockers.length > 0 ? 'blocked'
        : target.observation === 'verified' ? 'ready'
          : target.observation === 'missing' || target.content === 'drifted' ? 'pending' : 'unknown';
      const health = projectStates[state];
      addFields(lines, sections, `agent:${target.agent}`, width,
        [{ text: agentLabel(target.agent), role: 'platform' }, muted(`[${root.scope === 'user' ? '个人' : '当前项目'}]`), plain(delivery),
          statusCell(health.label, health.status, health.symbol)]);
      for (const blocker of target.blockers) {
        addFields(lines, sections, `agent:${target.agent}:${blocker.code}`, width,
          [muted('原因'), plain(blocker.code)]);
      }
    }
    if (root.agentResults.length === 0) {
      addFields(lines, sections, 'agents', width,
        [muted('本机 Agent'), root.blockers?.some((blocker) => blocker.code === 'localTargetsRequired')
          ? statusCell('未选择', 'warning', '!') : statusCell('目标未确认', 'muted', '?')]);
    }
    for (const target of root.targets) {
      const detail = subject.placements.find((placement) => placement.scope === target.scope
        && (target.agent ? placement.agent === target.agent : placement.platform === target.platform)
        && (target.delivery ? placement.delivery === target.delivery : true));
      addFields(lines, sections, `placement:${placementIdentity(fromProjectTarget(target, detail, true))}`, width,
        placementFields(fromProjectTarget(target, detail, true)));
    }
    for (const dependency of root.dependencies) {
      if (dependency.targets.length === 0) continue;
      addFields(lines, sections, `dependency:${dependency.pluginId}`, width,
        [muted('依赖'), plain(dependency.displayName)]);
      for (const target of dependency.targets) addFields(lines, sections,
        `dependency:${dependency.pluginId}:${placementIdentity(fromProjectTarget(target))}`,
        width, placementFields(fromProjectTarget(target)));
    }
    return { lines, sections };
  }
  for (const target of root.targets) {
    const detail = subject.placements.find((placement) => placement.scope === target.scope
      && (target.agent ? placement.agent === target.agent : placement.platform === target.platform)
      && (target.delivery ? placement.delivery === target.delivery : true));
    addFields(lines, sections, `placement:${placementIdentity(fromProjectTarget(target, detail, root.section === 'declared'))}`, width,
      placementFields(fromProjectTarget(target, detail, root.section === 'declared')));
  }
  if (root.targets.length === 0) {
    addFields(lines, sections, 'placements', width,
      [muted('使用位置'), statusCell('未确认', 'muted', '?')]);
  }
  for (const dependency of root.dependencies) {
    if (dependency.targets.length === 0) continue;
    addFields(lines, sections, `dependency:${dependency.pluginId}`, width,
      [muted('依赖'), plain(dependency.displayName)]);
    for (const target of dependency.targets) {
      addFields(lines, sections,
        `dependency:${dependency.pluginId}:${placementIdentity(fromProjectTarget(target))}`,
        width, placementFields(fromProjectTarget(target)));
    }
  }
  return { lines, sections };
}

function layout(lines: CardLine[], sections: CardSection[]): EntityCardLayout {
  return { headerHeight: 2, factRows: lines.length, fullHeight: lines.length + 3, sections };
}

export function pluginDetailCardLayout(subject: PluginDetailSubject, width: number): EntityCardLayout {
  const { lines, sections } = pluginFacts(subject, width);
  return { headerHeight: 1, factRows: lines.length, fullHeight: lines.length + 2,
    horizontalPaging: true, sections };
}

export function projectRootCardLayout(
  root: ProjectInventoryRoot, subject: PluginDetailSubject, width: number,
): EntityCardLayout {
  const { lines, sections } = projectFacts(root, subject, width);
  return layout(lines, sections);
}

export function EntityIdentityCard(props: {
  width: number;
  title: string;
  sourceId?: string;
  focused?: boolean;
  children: ReactNode;
}): React.JSX.Element {
  const sizes = identityWidths(props.sourceId, props.width);
  const borderColor = props.focused ? tuiTheme.colors.accent : tuiTheme.colors.border;
  return <Box width={props.width} borderStyle="round" borderColor={borderColor}
    flexDirection="column" paddingX={1}
    backgroundColor={props.focused ? tuiTheme.colors.selectionBackground : undefined}>
    <Box width={innerWidth(props.width)} height={1} justifyContent="space-between" overflow="hidden">
      <Text bold color={tuiTheme.colors.text} wrap="truncate-end">
        {props.focused ? '› ' : '  '}{preview(props.title, sizes.titleWidth)}
      </Text>
      {props.sourceId ? <Text color={tuiTheme.colors.muted} wrap="truncate-end">
        {preview(`[${props.sourceId}]`, sizes.sourceWidth)}
      </Text> : null}
    </Box>
    {props.children}
  </Box>;
}

/** A single placement uses the same fields, colors, and wrapping as detail and project cards. */
export function EntityPlacementRow(props: { placement: EntityPlacementFact; width: number }): React.JSX.Element {
  return <FactRows lines={placementRows(props.placement, props.width)} />;
}

function placementRows(placement: EntityPlacementFact, width: number): CardLine[] {
  const lines: CardLine[] = [];
  addFields(lines, [], 'placement', width, placementFields(placement));
  if (placement.declared && placement.expectedVersion) {
    addFields(lines, [], 'expectedVersion', width,
      [muted('声明期望版本'), plain(placement.expectedVersion)]);
  }
  return lines;
}

export function entityPlacementRowHeight(placement: EntityPlacementFact, width: number): number {
  return placementRows(placement, width).length;
}

function cardWindow(lines: CardLine[], offset: number, limit: number | undefined) {
  const start = Math.min(Math.max(0, Math.floor(offset)), Math.max(0, lines.length - 1));
  const shown = lines.slice(start, limit === undefined ? undefined : start + Math.max(1, Math.floor(limit)));
  return { shown, before: start > 0, after: start + shown.length < lines.length };
}

/** Exact rendered height when lineOffset/lineLimit select fact rows. */
export function entityCardWindowHeight(
  card: EntityCardLayout, lineOffset = 0, lineLimit?: number,
): number {
  const start = Math.min(Math.max(0, Math.floor(lineOffset)), Math.max(0, card.factRows - 1));
  const visible = Math.min(card.factRows - start,
    lineLimit === undefined ? card.factRows : Math.max(1, Math.floor(lineLimit)));
  return card.headerHeight + visible + 1 + (card.horizontalPaging
    ? Number(lineLimit !== undefined)
    : Number(start > 0) + Number(start + visible < card.factRows));
}

function FactRows(props: {
  lines: CardLine[]; offset?: number; limit?: number; horizontalPaging?: boolean; columns?: number;
}): React.JSX.Element {
  const window = cardWindow(props.lines, props.offset ?? 0, props.limit);
  return <>
    {!props.horizontalPaging && window.before ? <Text color={tuiTheme.colors.muted}>↑ 前面还有信息</Text> : null}
    {window.shown.map((line, index) => <Text key={`${props.offset ?? 0}:${index}`}>
      {line.cells.map((cell, cellIndex) => <Text key={cellIndex}
        color={cell.role === 'status' ? tuiTheme.statusColors[cell.status ?? 'muted']
          : cell.role === 'muted' ? tuiTheme.colors.muted : tuiTheme.colors.text}
        bold={cell.role === 'platform'}>
        {cell.role === 'status' && props.columns
          ? ' '.repeat(Math.max(Number(cellIndex > 0), props.columns
              - line.cells.reduce((sum, entry) => sum + stringWidth(entry.text), 0)
              - Math.max(0, line.cells.length - 2)))
          : cellIndex > 0 ? ' ' : ''}{cell.text}
      </Text>)}
    </Text>)}
    {!props.horizontalPaging && window.after ? <Text color={tuiTheme.colors.muted}>↓ 后面还有信息</Text> : null}
    {props.horizontalPaging && props.limit !== undefined ? <Pager
      page={Math.floor((props.offset ?? 0) / Math.max(1, props.limit)) + 1}
      pageCount={Math.max(1, Math.ceil(props.lines.length / Math.max(1, props.limit)))}
      columns={props.columns} /> : null}
  </>;
}

export function PluginDetailCard(props: {
  subject: PluginDetailSubject;
  width: number;
  /** Fact-line offset; excludes the identity line and borders. */
  lineOffset?: number;
  /** Fact-line count; excludes the identity line, borders, and overflow cues. */
  lineLimit?: number;
}): React.JSX.Element {
  const { lines } = pluginFacts(props.subject, props.width);
  const sizes = identityWidths(props.subject.sourceId, props.width);
  return <ObjectCardFrame width={props.width} title={preview(props.subject.displayName, sizes.titleWidth)}
    headerMeta={preview(props.subject.sourceId, Math.max(1, sizes.sourceWidth - 2))}>
    <FactRows lines={lines} offset={props.lineOffset} limit={props.lineLimit}
      horizontalPaging columns={innerWidth(props.width)} />
  </ObjectCardFrame>;
}

export function ProjectRootCard(props: {
  root: ProjectInventoryRoot;
  subject: PluginDetailSubject;
  width: number;
  focused?: boolean;
  lineOffset?: number;
  lineLimit?: number;
}): React.JSX.Element {
  const { lines } = projectFacts(props.root, props.subject, props.width);
  return <EntityIdentityCard width={props.width} title={props.subject.displayName}
    sourceId={props.subject.sourceId} focused={props.focused}>
    <FactRows lines={lines} offset={props.lineOffset} limit={props.lineLimit} />
  </EntityIdentityCard>;
}
