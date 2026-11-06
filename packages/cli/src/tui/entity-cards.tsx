import { PLATFORM_TARGETS } from '@lesliechan721/aw-plugin-core';
import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import stringWidth from 'string-width';

import { compareStrictSemVer, tryParseStrictSemVer } from '../utils/manifest.js';
import { ObjectCardFrame } from './components.js';
import { agentLabel, platformLabel, scopeLabel, recoveryReason } from './glossary.js';
import { Pager } from './reader.js';
import type { PluginDetailPlacement, PluginDetailSubject } from './plugin-detail.js';
import type { InventoryRoot as ProjectInventoryRoot, InventoryState as ProjectInventoryState,
  InventoryTarget as ProjectInventoryTarget } from './scoped-inventory.js';
import { tuiTheme, type TuiStatus } from './theme.js';
import { wrapDisplayText } from './viewport.js';

type CellRole = 'text' | 'muted' | 'platform' | 'status' | 'tableStatus';
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
  const badges = (['user', 'project'] as const).flatMap((scope) => {
    const declared = subject.declarations[scope].state === 'declared';
    const placements = subject.placements.filter((entry) => entry.scope === scope);
    if (!declared && !placements.length) return [];
    const ready = placements.length > 0 && placements.every((entry) => placementHealth({ ...entry, shared: false }).status === 'success');
    const residue = placements.length > 0 && placements.every((entry) => entry.statusState === 'orphaned');
    const dependency = !declared && !residue && subject.relations.incoming.some((entry) => entry.declared)
      && placements.some((entry) => entry.observation === 'known');
    const suffix = declared ? ready ? '' : ' 待安装' : residue ? ' 可清理' : dependency ? ' 依赖' : ' 未确认';
    return [statusCell(`${scopeLabel(scope)}${suffix}`,
      ready && (declared || dependency) ? 'success' : 'warning', declared ? ready ? '■' : '□' : residue ? '!' : dependency ? '▣' : '?')];
  });
  addFields(lines, sections, 'scope', width, badges.length ? badges : [muted('○ 尚未添加')]);
  const showLocation = width >= 76;
  const pad = (text: string, columns: number): string => text + ' '.repeat(Math.max(0, columns - stringWidth(text)));
  addFields(lines, sections, 'columns', width, [muted(`${pad('Agent', 14)}${pad('状态', 12)}${showLocation ? pad('位置', 12) : ''}版本`)]);
  for (const placement of subject.placements) {
    const health = placementHealth({ ...placement, shared: placement.sharedWithCurrentProject });
    const label = placement.agent ? agentLabel(placement.agent) : placement.platformLabel;
    const version = placement.installedVersion ?? '—';
    const changed = placement.installedVersion && subject.catalogVersion && tryParseStrictSemVer(placement.installedVersion) && tryParseStrictSemVer(subject.catalogVersion)
      && compareStrictSemVer(placement.installedVersion, subject.catalogVersion) < 0;
    addFields(lines, sections, `placement:${placementIdentity(placement)}`, width,
      [plain(pad(label, 13)), { text: pad(`${health.symbol} ${health.label}`, 11), role: 'tableStatus', status: health.status },
        plain(`${showLocation ? pad(scopeLabel(placement.scope), 12) : ''}${version}`),
        ...(changed ? [{ text: '↑', role: 'tableStatus' as const, status: 'warning' as const }] : [])]);
    if (health.status === 'error' || placement.observation === 'unknown') {
      const reasons: Record<string, string> = {
        permissionDenied: '没有写入权限', sourceUnavailable: '插件来源不可用',
        dependencyApplyFailed: '所需插件未完成更新', nativeStateUnreadable: '无法读取 Agent 状态',
        targetInspectionFailed: '无法确认安装状态', configInvalid: '插件设置需要修正',
        foreignContent: '目录包含其他内容', ownershipMismatch: '无法确认目录归属',
      };
      const reason = placement.reasonCodes.map((code) => reasons[code]).find(Boolean)
        ?? (placement.observation === 'unknown' ? '无法确认安装状态，请查看技术详情' : '安装受阻，请查看技术详情');
      addFields(lines, sections, `reason:${placementIdentity(placement)}`, width, [muted(`  └ ${reason}`)]);
    }
  }
  if (!subject.placements.length) addFields(lines, sections, 'placements', width,
    subject.selectedAgents?.filter((target) => subject.supportedPlatforms?.includes(target))
      .map((target) => statusCell(agentLabel(target), 'info', '+')) ?? [muted('尚无安装结果')]);
  const unselected = subject.selectedAgents ? PLATFORM_TARGETS.filter((target) => !subject.selectedAgents!.includes(target)) : [];
  if (unselected.length) addFields(lines, sections, 'unselected', width,
    [muted(`– 本机未启用：${unselected.map(agentLabel).join(' · ')}`)]);
  addFields(lines, sections, 'catalogVersion', width,
    [muted('最新版本'), plain(subject.catalogVersion ?? '未确认')]);
  for (const [kind, relations] of [['依赖', subject.relations.outgoing], ['被依赖', subject.relations.incoming]] as const) {
    if (relations.length) addFields(lines, sections, kind, width,
      [muted(kind), ...relations.map((relation) => statusCell(relation.displayName,
        relation.verified ? 'success' : 'muted', relation.verified ? '✓' : '?'))]);
  }
  return { lines, sections };
}

function projectFacts(root: ProjectInventoryRoot, subject: PluginDetailSubject, width: number) {
  const lines: CardLine[] = [];
  const sections: CardSection[] = [];
  addIdentityOverflow(lines, sections, subject, width);
  if (root.agentResults) {
    const declared = root.section === 'declared';
    const pending = root.agentResults.length > 0 && root.agentResults.every((target) =>
      target.observation === 'missing' || target.content === 'absent');
    const residue = subject.placements.some((entry) => entry.scope === root.scope && entry.statusState === 'orphaned');
    const dependency = !declared && !residue && subject.relations.incoming.some((entry) => entry.declared)
      && root.agentResults.some((target) => target.observation === 'verified');
    const suffix = declared ? pending ? ' 待安装' : '' : residue ? ' 可清理' : dependency ? ' 依赖' : ' 未确认';
    addFields(lines, sections, 'scope', width, [statusCell(`${scopeLabel(root.scope ?? 'project')}${suffix}`,
      root.state === 'ready' && (declared || dependency) ? 'success' : 'warning',
      declared ? pending ? '□' : '■' : residue ? '!' : dependency ? '▣' : '?')]);
    if (root.sourceState && root.sourceState !== 'ready') addFields(lines, sections, 'sourceState', width,
      [statusCell(root.sourceState === 'missing' ? '插件来源缺失' : '插件来源不可用', 'warning', '!')]);
    for (const blocker of root.blockers ?? []) addFields(lines, sections, `blocker:${blocker.code}`, width,
      [statusCell(recoveryReason(blocker.code), 'warning', '!')]);
    for (const target of root.agentResults) {
      const state: ProjectInventoryState = target.blockers.length > 0 || target.content === 'conflict' ? 'blocked'
        : target.observation === 'verified' ? 'ready'
          : target.observation === 'missing' || target.content === 'drifted' ? 'pending' : 'unknown';
      const health = target.satisfaction === 'unsupported' || target.reasons?.some((reason) => reason.code === 'deliveryUnsupported')
        ? { label: '不支持', status: 'muted' as const, symbol: '–' }
        : target.satisfaction === 'excluded' ? { label: '已关闭', status: 'muted' as const, symbol: '◇' }
          : projectStates[state];
      const installed = root.targets.find((entry) => entry.agent === target.agent
        || !entry.agent && entry.platform === target.agent);
      addFields(lines, sections, `agent:${target.agent}`, width,
        [statusCell(agentLabel(target.agent), health.status, health.symbol), plain(health.label),
          ...(installed?.installedVersion ? [muted(installed.installedVersion)] : [])]);
      for (const reason of [...target.blockers, ...(target.reasons ?? [])]) addFields(lines, sections,
        `agent:${target.agent}:${reason.code}`, width, [muted(`  └ ${recoveryReason(reason.code)}`)]);
    }
    if (root.agentResults.length === 0) addFields(lines, sections, 'agents', width,
      [muted('本机 Agent'), root.blockers?.some((blocker) => blocker.code === 'localTargetsRequired')
        ? statusCell('未选择', 'warning', '!') : statusCell('目标未确认', 'muted', '?')]);
    for (const dependency of root.dependencies) addFields(lines, sections, `dependency:${dependency.pluginId}`, width,
      [muted('依赖'), statusCell(dependency.displayName,
        dependency.targets.length && dependency.targets.every((target) => target.state === 'ready') ? 'success' : 'muted',
        dependency.targets.length && dependency.targets.every((target) => target.state === 'ready') ? '✓' : '?')]);
    return { lines, sections };
  }
  const overall = projectStates[root.state];
  addFields(lines, sections, 'overall', width,
    [muted('总体状态'), statusCell(root.state === 'ready' ? '就绪' : overall.label, overall.status, overall.symbol)]);
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
    horizontalPaging: false, sections };
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
        color={cell.role === 'status' || cell.role === 'tableStatus' ? tuiTheme.statusColors[cell.status ?? 'muted']
          : cell.role === 'muted' ? tuiTheme.colors.muted : tuiTheme.colors.text}
        bold={cell.role === 'platform'}>
        {cell.role === 'status' && props.columns && cellIndex > 0
          && line.cells.filter((entry) => entry.role === 'status').length === 1
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
      columns={innerWidth(props.width)} />
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
