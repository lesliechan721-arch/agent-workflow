import { Box, Text, useInput, useWindowSize } from 'ink';
import { useEffect, useRef, useState } from 'react';
import path from 'node:path';

import type { CatalogSource, PlatformName, Scope } from '../types.js';
import {
  CATALOG_BETA_REF,
  CATALOG_LATEST_REF,
  OFFICIAL_CATALOG_SOURCE_SSH_URL,
  OFFICIAL_CATALOG_SOURCE_URL,
} from '../constants.js';
import { CATALOG_SOURCE_ID_PATTERN } from '../utils/catalog-sources.js';
import { canonicalizeCatalogGitUrl } from '../utils/catalog-source-identity.js';
import { normalizePortableAgents } from '../portable/commands.js';
import { projectCatalogSourceLocation } from '../utils/catalog-source-presentation.js';
import {
  ActionRow,
  Callout,
  ChoiceRow,
  DiagnosticSummary,
  InputCard,
  PluginListRow,
  ProgressRow,
  ResultCard,
  ResultRow,
  ReviewCard,
  ReviewChangeRow,
  ScreenFrame,
  SectionCard,
  SectionRow,
  StaticRow,
  StatusCard,
  TaskRow,
  TechnicalDetails,
  ToggleRow,
} from './components.js';
import {
  safeDiagnosticCode,
  sanitizeDiagnosticText,
  type DiagnosticSummaryViewModel,
} from './diagnostics.js';
import type {
  OperationIntent,
  OperationReviewChange,
  OperationResultSummary,
  TuiController,
  TuiControllerSnapshot,
} from './controller.js';
import { extractPortableError, userIssueKey } from './controller.js';
import type { CatalogSourceGenerationViewModel } from './catalog-generation.js';
import { resolveTuiSizePolicy } from './layout.js';
import { InputDisplay, removeLastGrapheme } from './input-display.js';
import { catalogRefPolicyForPreset } from './source-ref-presets.js';
import type {
  ConfigFieldViewModel,
  ConfigPageViewModel,
  PlatformPlacementSummary,
  PluginDependencyItemViewModel,
  PluginDependencyOverviewViewModel,
  PluginListItemViewModel,
  UserIssueActionViewModel,
  UserIssueViewModel,
  PluginMenuAction,
  SourceDetailViewModel,
  SourceHealthViewModel,
} from './model.js';
import {
  buildPlatformActions,
  buildPluginDetailActions,
  buildPluginPreviewActions,
  hasInstalledPlacement,
} from './model.js';
import type { PluginInstallFilter, TuiRoute } from './router.js';
import { tuiTheme } from './theme.js';
import { contentRowBudget, rowViewport, type RowViewport } from './viewport.js';

export const CONSOLE_V4_SCREEN_IDS = [
  'G01', 'G02', 'G03', 'G04', 'G05',
  'P01', 'P02', 'P03', 'P04', 'P05', 'P06', 'P07', 'P08', 'P09', 'P10',
  'P11', 'P12', 'P13', 'P14', 'P15', 'P16', 'P17', 'P18', 'P19', 'P20', 'P21',
  'C01', 'C02', 'C03', 'C04', 'C05', 'C06', 'C07', 'C08', 'C09', 'C10',
  'C11', 'C12', 'C13', 'C14', 'C15', 'C16', 'C17',
  'S01', 'S02', 'S03', 'S04', 'S05', 'S06', 'S07', 'S08', 'S09',
  'S10', 'S11', 'S12', 'S13', 'S14', 'S15', 'S16', 'S17', 'S18',
  'I01', 'I02', 'I03', 'I04', 'I05', 'I06', 'I07', 'I08', 'I09',
  'I10', 'I11', 'I12', 'I13',
  'D01', 'D02', 'D03', 'D04', 'D05', 'D06', 'D07', 'D08', 'D09',
  'D10', 'D11', 'D12', 'D13', 'D14', 'D15', 'D16', 'D17',
  'U01', 'U02', 'U03', 'U04', 'U05', 'U06', 'U07', 'U08', 'U09', 'U10', 'U11',
  'K01', 'K02', 'K03', 'K04', 'K05', 'K06', 'K07',
] as const;

export type ConsoleV4ScreenId = typeof CONSOLE_V4_SCREEN_IDS[number];
type Overlay = 'help' | 'exit' | 'discard' | undefined;

interface ActionItem {
  label: string;
  description?: string;
  meta?: string;
  status?: 'success' | 'warning' | 'error' | 'info' | 'muted';
  disabled?: string;
  run?: () => void | Promise<void>;
  configKey?: string;
  selected?: boolean;
}

interface DynamicMenuFocus {
  routeKey: string;
  actionIds: string;
  focusedActionId?: string;
}

function pluginMenuActionId(action: PluginMenuAction): string {
  return action.id === 'platform' || action.id === 'scopeConflict'
    ? `${action.id}:${action.platform}`
    : action.id === 'addScope'
      ? `${action.id}:${action.platform}:${action.scope}`
      : action.id === 'resolveScopeConflict'
        ? `${action.id}:${action.pluginId}:${action.platform}:${action.scope}`
        : action.id;
}

interface PluginListRowViewModel {
  pluginId: string;
  name: string;
  sourceLabel: string;
  description: string;
  placementSummary: string;
  statusLabel: string;
  status: 'success' | 'warning' | 'error' | 'muted';
}

type SemanticRowKind = 'task' | 'section' | 'choice' | 'toggle' | 'action';
type HelpRow = readonly [key: string, meaning: string];

interface SourceDraft {
  owner: string;
  mode: 'add' | 'update';
  sourceId: string;
  type: 'git' | 'path';
  location: string;
  refPolicy: 'cliChannel' | 'explicit';
  ref: string;
  subdir: string;
  editField?: 'location' | 'refPolicy' | 'subdir';
}

function isCharacterInputMode(route: TuiRoute, searchMode: boolean): boolean {
  return searchMode
    || route.name === 'portableAgentInput'
    || route.name === 'configFieldEditor' && route.editor !== 'enum' && route.editor !== 'boolean'
    || route.name === 'sourceAdd' && route.step !== 'type' && route.step !== 'refPolicy';
}

function helpRowsForRoute(
  route: TuiRoute,
  actionCount: number,
  supportsTechnicalDetails: boolean,
  busy: boolean,
): HelpRow[] {
  const rows: HelpRow[] = [];
  if (!busy && actionCount > 1) rows.push(['↑/↓ · j/k', '移动当前唯一焦点']);
  if (!busy && actionCount > 0) rows.push(['Enter', '打开、选择或继续']);
  if (!busy && route.name !== 'home') rows.push(['Esc / b', '返回上一页']);
  if (route.name === 'pluginList') {
    rows.push(['←/→ · [ / ]', '切换来源']);
    rows.push(['/', '进入搜索']);
    if (route.mode === 'browse') rows.push(['f', '切换全部或未安装']);
  }
  if (route.name === 'portableSkillSelect') {
    rows.push(['Space', '切换当前 Skill']);
    rows.push(['a', '全选 Skills']);
  }
  if (route.name === 'configFields' && route.layer.scope !== 'effective') {
    rows.push(['s', '保存设置']);
    rows.push(['u', '恢复当前字段继承']);
  }
  if (route.name === 'sourceList' || route.name === 'sourceDetail') {
    rows.push(['r', '重新检查来源']);
  }
  if (supportsTechnicalDetails) {
    rows.push(['d', route.name === 'progress' ? '打开技术进度' : '打开技术详情']);
  }
  rows.push(['q / Ctrl-C', busy ? '操作完成后退出' : '退出控制台']);
  rows.push(['?', '关闭帮助']);
  return rows;
}

function configOwnerKey(route: Extract<TuiRoute, {
  name: 'configFields' | 'configFieldEditor' | 'configFieldAction';
}>): string {
  return `${route.pluginId}\0${route.layer.scope}\0${route.layer.projectLayer}`;
}

function configPageMatches(
  page: ConfigPageViewModel | undefined,
  route: Extract<TuiRoute, { name: 'configFields' | 'configFieldEditor' | 'configFieldAction' }> | undefined,
): page is ConfigPageViewModel {
  return Boolean(page && route
    && page.pluginId === route.pluginId
    && page.layer.scope === route.layer.scope
    && page.layer.projectLayer === route.layer.projectLayer);
}

function platformLabel(platform: PlatformName): string {
  return platform === 'codex' ? 'Codex' : 'Claude Code';
}

function partialRetryAction(
  operationKind: OperationIntent['kind'] | undefined,
  originalAction: Extract<OperationIntent, { kind: 'pluginWrite' }>['action'] | undefined,
  targetState: 'present' | 'absent' | 'partial' | 'error' | undefined,
): Extract<OperationIntent, { kind: 'pluginWrite' }>['action'] | undefined {
  if (!targetState) return undefined;
  if (operationKind === 'configSave' || operationKind === 'configReset') {
    return targetState === 'absent' ? undefined : 'reinstall';
  }
  if (originalAction === 'uninstall') {
    return targetState === 'present' || targetState === 'partial' ? 'uninstall' : undefined;
  }
  if (originalAction === 'cleanup') return targetState === 'absent' ? undefined : 'cleanup';
  if (targetState === 'absent') return 'install';
  if (targetState === 'partial') return 'reinstall';
  if (targetState === 'error') return undefined;
  return originalAction === 'upgrade' ? 'upgrade' : 'reinstall';
}

function scopeLabel(scope: Scope): string {
  return scope === 'user' ? '所有项目' : '当前项目';
}

function statusText(plugin: PluginListItemViewModel): string {
  return {
    available: '未添加',
    installed: '可用',
    needsAttention: '需要处理',
    unavailable: '来源不可用',
  }[plugin.aggregateStatus];
}

function pluginPlacementSummary(plugin: PluginListItemViewModel): string {
  return plugin.supportedPlatforms.map((platform) => {
    const label = platformLabel(platform);
    const placement = plugin.installedPlacements.find((entry) => entry.platform === platform);
    if (!placement || placement.state === 'notInstalled') return `${label} · 未添加`;
    if (placement.state === 'blocked') return `${label} · 无法添加 · 输出冲突`;
    if (placement.state === 'scopeConflict') return `${label} · 位置冲突`;
    if (placement.blockingReason === 'artifactCollision') {
      return `${label} · ${scopeLabel(placement.scope)} · 输出冲突`;
    }
    const health = placement.actualState === 'needsSync' ? '需要同步'
      : placement.actualState === 'drifted' ? '已漂移'
        : placement.actualState === 'conflict' ? '位置冲突'
          : placement.health === 'ready' ? '可用'
            : placement.health === 'incomplete' ? '需要处理' : '不可用';
    const desired = placement.desiredScopes?.length
      ? placement.desiredScopes.map(scopeLabel).join('+')
      : scopeLabel(placement.scope);
    return `${label} · ${desired} · ${health}`;
  }).join('  |  ') || '没有可用平台';
}

function issueGroupLabel(group: UserIssueViewModel['group']): string {
  return {
    sourceRemoved: '来源已移除',
    artifactCollision: '输出冲突',
    sourceUnavailable: '来源不可用',
    dependency: '依赖',
    scope: '位置',
    config: '设置',
    installation: '安装',
    diagnostic: '诊断',
  }[group];
}

function pluginRowStatus(plugin: PluginListItemViewModel): PluginListRowViewModel['status'] {
  if (plugin.aggregateStatus === 'needsAttention') return 'warning';
  if (plugin.aggregateStatus === 'installed') return 'success';
  if (plugin.aggregateStatus === 'unavailable') return 'error';
  return 'muted';
}

function moveFocus(actions: ActionItem[], current: number, direction: -1 | 1): number {
  if (actions.length === 0) return 0;
  for (let offset = 1; offset <= actions.length; offset += 1) {
    const next = (current + direction * offset + actions.length) % actions.length;
    if (!actions[next]?.disabled) return next;
  }
  return current;
}

function moveIndex(count: number, current: number, direction: -1 | 1): number {
  if (count === 0) return 0;
  return (current + direction + count) % count;
}

function actionViewport(
  actions: ActionItem[],
  compact: boolean,
  focus: number,
  requestedOffset: number,
  lineBudget: number,
): RowViewport {
  return rowViewport({
    rowHeights: actions.map((action) => compact || (!action.description && !action.disabled) ? 1 : 2),
    focus,
    requestedOffset,
    rowBudget: lineBudget,
  });
}

function portableSkillCandidateViewport(
  actions: ActionItem[],
  candidates: NonNullable<TuiControllerSnapshot['portableDraft']>['candidates'],
  compact: boolean,
  focus: number,
  requestedOffset: number,
  rowBudget: number,
): RowViewport {
  const candidateFocus = focus < candidates.length ? focus : requestedOffset;
  return groupedRowViewport({
    rowHeights: actions.map(() => compact ? 1 : 2),
    groupKeys: candidates.map((candidate) => candidate.providerPluginId),
    groupOverhead: 3,
    focus: candidateFocus,
    requestedOffset,
    rowBudget,
  });
}

function groupedRowViewport(options: {
  rowHeights: number[];
  groupKeys: Array<string | undefined>;
  groupOverhead: number;
  focus: number;
  requestedOffset: number;
  rowBudget: number;
}): RowViewport {
  const total = options.rowHeights.length;
  if (total === 0) {
    return { offset: 0, limit: 0, hiddenBefore: 0, hiddenAfter: 0, position: 0, total: 0 };
  }
  const focus = Math.min(Math.max(0, options.focus), total - 1);
  const height = (start: number, end: number): number => {
    let rows = 0;
    let previousGroup: string | undefined;
    for (let index = start; index < end; index += 1) {
      const group = options.groupKeys[index];
      if (group !== undefined && group !== previousGroup) rows += options.groupOverhead;
      rows += options.rowHeights[index] ?? 1;
      previousGroup = group;
    }
    return rows;
  };
  let offset = Math.min(Math.max(0, options.requestedOffset), focus);
  while (offset < focus && height(offset, focus + 1) > options.rowBudget) offset += 1;
  let end = focus + 1;
  while (end < total && height(offset, end + 1) <= options.rowBudget) end += 1;
  while (offset > 0 && height(offset - 1, end) <= options.rowBudget) offset -= 1;
  return {
    offset,
    limit: end - offset,
    hiddenBefore: offset,
    hiddenAfter: total - end,
    position: focus + 1,
    total,
  };
}

function prefixRowLimit(rowHeights: number[], rowBudget: number): number {
  let used = 0;
  let visible = 0;
  for (const rowHeight of rowHeights) {
    const hiddenSummary = visible + 1 < rowHeights.length ? 1 : 0;
    if (used + rowHeight + hiddenSummary > rowBudget) break;
    used += rowHeight;
    visible += 1;
  }
  return visible;
}

function portableScopeVariantsDiffer(
  candidate: NonNullable<TuiControllerSnapshot['portableDraft']>['candidates'][number],
): boolean {
  const project = candidate.scopeDetails.project;
  const user = candidate.scopeDetails.user;
  if (Boolean(project) !== Boolean(user)) return true;
  return Boolean(project && user && (
    project.description !== user.description
    || project.providerPluginId !== user.providerPluginId
    || project.providerDisplayName !== user.providerDisplayName
    || project.dynamic !== user.dynamic
    || project.filesDigest !== user.filesDigest
  ));
}

function portableScopeVariantLabel(
  scope: Scope,
  detail: NonNullable<TuiControllerSnapshot['portableDraft']>['candidates'][number]['scopeDetails'][Scope],
): string {
  if (!detail) return `${scope === 'project' ? '当前项目' : '所有项目'}：不可用`;
  return `${scope === 'project' ? '当前项目' : '所有项目'}：${detail.description} · ${detail.providerDisplayName}${detail.dynamic ? ' · 按设置生成' : ''}`;
}

function privatePathInput(value: string): string {
  if (!value) return '';
  const basename = value.split(/[\\/]/u).filter(Boolean).at(-1) ?? '已选择';
  return `已选择 / … / ${basename}`;
}

function portableBlockerDiagnostic(
  route: Extract<TuiRoute, { name: 'portableBlocker' }>,
): DiagnosticSummaryViewModel {
  const cliUnavailable = route.code === 'portableSkillsCliMissing'
    || route.code === 'portableSkillsCliIncompatible';
  const userMessage = route.code === 'requiredConfigMissing'
    ? '插件缺少生成内容所需的设置。'
    : route.code === 'portableScopeUnavailable'
      ? '至少一个所选 Skill 不适用于这个范围。'
      : cliUnavailable
        ? '没有找到兼容的 Skills CLI。'
        : '候选 Skill 没有通过 Portable 安全校验。';
  const blocked = route.code === 'requiredConfigMissing'
    ? '缺少生成 Skill 所需的设置；没有调用 Skills CLI。'
    : cliUnavailable
      ? '当前不能开始安装；没有调用 Skills CLI。'
      : route.code === 'portableScopeUnavailable'
        ? '所选内容不能在这个范围完整生成；没有开始写入。'
        : '候选内容没有通过安全校验；没有开始写入。';
  const nextStep = route.code === 'requiredConfigMissing'
    ? '完成插件设置，然后重新准备。'
    : cliUnavailable
      ? '安装或升级兼容的 Skills CLI，然后重新检查。'
      : route.code === 'portableScopeUnavailable'
        ? '返回 Skill 选择或更改范围，然后重新检查。'
        : '修复来源内容或修改选择，然后重新检查。';
  return {
    severity: 'error',
    title: route.code === 'portableScopeUnavailable' ? '所选范围不可用'
      : cliUnavailable ? '暂时无法安装通用 Skills' : '无法准备通用 Skills',
    userMessage,
    impact: [
      { state: 'blocked', message: blocked },
      { state: 'preserved', message: '现有插件、Skills、设置和 Portable 草稿保持不变。' },
    ],
    nextStep,
    technical: {
      code: safeDiagnosticCode(route.diagnosticCode, 'portableValidationFailed'),
      stage: cliUnavailable ? 'check-skills-cli' : 'prepare-portable',
      ...(cliUnavailable ? { context: [{
        key: 'compatibility' as const,
        value: 'Skills CLI >=1.5.23 <2.0.0',
      }] } : {}),
      checks: cliUnavailable
        ? ['检查 PATH 中的 Skills CLI 版本。', '安装兼容版本后运行“重新检查”。']
        : ['检查插件设置、所选范围和 Portable 来源内容。', '修复后运行“重新检查”。'],
    },
  };
}

function configUnavailableDiagnostic(
  route: Extract<TuiRoute, { name: 'configUnavailable' }>,
): DiagnosticSummaryViewModel {
  return {
    severity: 'error',
    title: 'Manifest 或来源不可用',
    userMessage: '当前无法取得可信的字段定义，因此不能验证新值。',
    impact: [
      { state: 'blocked', message: '恢复可信字段定义前，不能编辑或重置这个插件的设置。' },
      { state: 'preserved', message: '已保存的设置保持不变。' },
    ],
    nextStep: '重新检查来源，然后再次打开设置。',
    technical: {
      code: safeDiagnosticCode(route.diagnosticCode, 'configUnavailable'),
      stage: safeDiagnosticCode(route.diagnosticStage, 'read-config'),
      context: [
        { key: 'pluginId', value: route.pluginId },
        ...(route.layer ? [{ key: 'scope' as const, value: route.layer.scope }] : []),
      ],
      checks: ['恢复插件来源和可信 Manifest。', '重新检查来源后再次打开设置。'],
    },
  };
}

function sourceDiagnostic(
  sourceId: string,
  state: SourceHealthViewModel['state'] | 'error' | undefined,
  detail: SourceDetailViewModel | undefined,
  generation?: CatalogSourceGenerationViewModel,
): DiagnosticSummaryViewModel | undefined {
  const unavailable = state === 'unavailable' || state === 'error';
  if (!unavailable) return undefined;
  const metadataInvalid = generation?.errorCode === 'catalogGenerationMetadataInvalid';
  return {
    severity: 'error',
    title: 'Catalog 来源不可用',
    userMessage: '当前无法读取这个来源。',
    impact: [
      { state: 'blocked', message: '当前不能浏览或安装这个来源中的插件。' },
      { state: 'preserved', message: '已安装插件和已保存设置不会被删除。' },
    ],
    nextStep: metadataInvalid && generation.recoveryEntryPath
      ? `先安全删除 AW_HOME 下的精确条目 ${generation.recoveryEntryPath}，再运行 ${generation.syncInstruction}。`
      : '重新检查来源；如仍失败，请编辑来源 URL、路径或 ref。',
    technical: {
      code: safeDiagnosticCode(
        generation?.errorCode ?? detail?.errorCode,
        'catalogSourceUnavailable',
      ),
      stage: 'resolve-source',
      sourceId,
      ...(detail?.requestedRef ? { requestedRef: detail.requestedRef } : {}),
      ...(detail?.resolvedCommit ? { resolvedCommit: detail.resolvedCommit } : {}),
      ...(metadataInvalid && generation.recoveryEntryPath
        ? { context: [{ key: 'storeEntry' as const, value: generation.recoveryEntryPath }] }
        : {}),
      checks: metadataInvalid && generation.recoveryEntryPath
        ? [
            `确认损坏条目为 AW_HOME/${generation.recoveryEntryPath}。`,
            '只删除该精确条目，不删除 Catalog store 根或其它 digest。',
            `运行 ${generation.syncInstruction} 重建 Active。`,
          ]
        : ['检查 Git URL、ref 或本地目录。', '确认当前终端具备来源授权。', '运行“重新检查来源”验证修复。'],
    },
  };
}

function terminalTextWidth(value: string): number {
  return [...value].reduce((width, character) => width + (character.codePointAt(0)! > 0xff ? 2 : 1), 0);
}

function SemanticRows(props: {
  actions: ActionItem[];
  focus: number;
  kind: SemanticRowKind;
  compact?: boolean;
  offset?: number;
  limit?: number;
}): React.JSX.Element {
  const offset = props.offset ?? 0;
  const actions = props.limit === undefined
    ? props.actions.slice(offset)
    : props.actions.slice(offset, offset + props.limit);
  return (
    <Box flexDirection="column">
      {actions.map((action, visibleIndex) => {
        const index = visibleIndex + offset;
        const rowProps = {
          title: action.label,
          description: action.description,
          meta: action.meta ?? (props.compact ? action.disabled : undefined),
          status: action.status,
          disabled: action.disabled,
          focused: index === props.focus,
          compact: props.compact,
        };
        if (props.kind === 'section') return <SectionRow key={`${action.label}:${index}`} {...rowProps} />;
        if (props.kind === 'choice') {
          return <ChoiceRow key={`${action.label}:${index}`} {...rowProps} selected={Boolean(action.selected)} />;
        }
        if (props.kind === 'toggle') {
          return <ToggleRow key={`${action.label}:${index}`} {...rowProps} selected={Boolean(action.selected)} />;
        }
        if (props.kind === 'action') return <ActionRow key={`${action.label}:${index}`} {...rowProps} />;
        return <TaskRow key={`${action.label}:${index}`} {...rowProps} />;
      })}
    </Box>
  );
}

function PluginRows(props: {
  rows: PluginListRowViewModel[];
  focus: number;
  viewport: RowViewport;
}): React.JSX.Element {
  return (
    <Box flexDirection="column">
      {props.rows.slice(props.viewport.offset, props.viewport.offset + props.viewport.limit)
        .map((row, visibleIndex) => (
          <PluginListRow
            key={row.pluginId}
            name={row.name}
            sourceLabel={row.sourceLabel}
            description={row.description}
            placementSummary={row.placementSummary}
            statusLabel={row.statusLabel}
            status={row.status}
            focused={props.viewport.offset + visibleIndex === props.focus}
          />
        ))}
    </Box>
  );
}

function IssueTechnicalDetails(props: {
  details: UserIssueViewModel['technicalDetails'];
  compact: boolean;
}): React.JSX.Element | null {
  const visible = props.details.slice(0, props.compact ? 1 : 2);
  if (visible.length === 0) return null;
  const hidden = props.details.length - visible.length;
  return <TechnicalDetails>{visible.flatMap((detail, index) => [
    <StaticRow key={`${detail.code}:${index}:code`} title={detail.code} compact />,
    <StaticRow
      key={`${detail.code}:${index}:message`}
      title={detail.message}
      meta={index === visible.length - 1 && hidden > 0 ? `另有 ${hidden} 项` : undefined}
      compact
    />,
  ])}</TechnicalDetails>;
}

function SourceTabs(props: {
  controller: TuiController;
  current: string;
  compact: boolean;
  columns: number;
  mode: 'browse' | 'installed';
  query?: string;
  installFilter: PluginInstallFilter;
}): React.JSX.Element {
  const filter = { mode: props.mode, query: props.query, installFilter: props.installFilter };
  const tabs = [{ id: 'all', label: '全部', count: props.controller.listPlugins(filter).length },
    ...props.controller.listSources().map((source) => ({
      ...source,
      count: props.controller.listPlugins({ ...filter, sourceId: source.id }).length,
    }))];
  const index = Math.max(0, tabs.findIndex((tab) => tab.id === props.current));
  const fullText = `来源  ${tabs.map((tab) => {
    const state = 'state' in tab ? tab.state : 'ready';
    return `${tab.id === props.current ? '[' : ''}${tab.label}${state === 'error' ? ' !' : ` ${tab.count ?? ''}`}${tab.id === props.current ? ']' : ''}  `;
  }).join('')}`;
  if (props.compact || terminalTextWidth(fullText) > props.columns) {
    const tab = tabs[index]!;
    return <Text wrap="truncate-end">来源  <Text color={tuiTheme.colors.accent}>[{tab.label}]</Text>  {index + 1} / {tabs.length}  ← →</Text>;
  }
  return (
    <Text wrap="truncate-end">
      来源  {tabs.map((tab) => {
        const active = tab.id === props.current;
        const state = 'state' in tab ? tab.state : 'ready';
        return (
          <Text
            key={tab.id}
            bold={active}
            color={active ? tuiTheme.colors.accent
              : state === 'error' ? tuiTheme.statusColors.error
              : tuiTheme.colors.muted}
          >
            {active ? '[' : ''}{tab.label}{state === 'error' ? ' !' : ` ${tab.count ?? ''}`}{active ? ']' : ''}{'  '}
          </Text>
        );
      })}
    </Text>
  );
}

interface ConfigTab {
  id: string;
  label: string;
  count: number;
  kind: 'group' | 'presets';
}

function configTabs(page: ConfigPageViewModel): ConfigTab[] {
  return [
    ...page.groups.map((group) => ({
      id: group.id,
      label: group.title,
      count: group.fields.length,
      kind: 'group' as const,
    })),
    ...(page.presets.length > 0
      ? [{ id: '@presets', label: '快速方案', count: page.presets.length, kind: 'presets' as const }]
      : []),
  ];
}

function ConfigGroupTabs(props: {
  tabs: ConfigTab[];
  current: string;
  compact: boolean;
  columns: number;
}): React.JSX.Element {
  const index = Math.max(0, props.tabs.findIndex((tab) => tab.id === props.current));
  const fullText = `分组  ${props.tabs.map((tab) => `${tab.id === props.current ? '[' : ''}${tab.label} ${tab.count}${tab.id === props.current ? ']' : ''}  `).join('')}`;
  if (props.compact || terminalTextWidth(fullText) > props.columns) {
    const tab = props.tabs[index]!;
    return <Text wrap="truncate-end">分组  <Text color={tuiTheme.colors.accent}>[{tab.label} {tab.count}]</Text>  {index + 1} / {props.tabs.length}  ← →</Text>;
  }
  return (
    <Text wrap="truncate-end">
      分组  {props.tabs.map((tab) => {
        const active = tab.id === props.current;
        return <Text key={tab.id} bold={active} color={active ? tuiTheme.colors.accent : tuiTheme.colors.muted}>
          {active ? '[' : ''}{tab.label} {tab.count}{active ? ']' : ''}{'  '}
        </Text>;
      })}← →
    </Text>
  );
}

function placementStatus(placement: PlatformPlacementSummary): {
  value: string;
  status: ActionItem['status'];
  description: string;
} {
  if (placement.state === 'notInstalled') {
    return { value: '未添加', status: 'muted', description: '选择使用位置后添加' };
  }
  if (placement.state === 'blocked') {
    return { value: '无法添加', status: 'error', description: '输出冲突；不会覆盖或删除占用内容' };
  }
  if (placement.state === 'scopeConflict') {
    return { value: '位置冲突', status: 'warning', description: '需要先处理两个安装位置' };
  }
  if (placement.blockingReason === 'artifactCollision') {
    return { value: '输出冲突', status: 'error', description: '只允许查看或安全移除受管内容' };
  }
  return {
    value: `${placement.desiredScopes?.map(scopeLabel).join('+') || scopeLabel(placement.scope)} · ${placement.actualState === 'needsSync' ? '需要同步' : placement.actualState === 'drifted' ? '已漂移' : placement.actualState === 'conflict' ? '位置冲突' : placement.health === 'ready' ? '可用' : placement.health === 'incomplete' ? '需要处理' : '不可用'}`,
    status: placement.actualState === 'conflict' ? 'error' : placement.health === 'ready' ? 'success' : placement.health === 'incomplete' ? 'warning' : 'error',
    description: placement.actualState === 'needsSync' ? 'desired intent 与现场不同；可安全同步'
      : placement.actualState === 'drifted' ? '现场已漂移；查看同步计划'
        : placement.actualState === 'conflict' ? 'mixed 或 AW-only 重叠；查看恢复路径'
          : placement.health === 'ready' ? '当前检查正常' : '查看影响和建议操作',
  };
}

function dependencyStatus(item: PluginDependencyItemViewModel): {
  value: string;
  status: ActionItem['status'];
} {
  if (item.aggregateStatus === 'ready') return { value: '已可用', status: 'success' };
  if (item.aggregateStatus === 'notInstalled') return { value: '未添加', status: 'muted' };
  if (item.aggregateStatus === 'needsAttention') return { value: '需要处理', status: 'warning' };
  return { value: '不可用', status: 'error' };
}

function dependencyPlacementLabel(item: PluginDependencyItemViewModel): string {
  const aggregate = dependencyStatus(item);
  const installed = item.placements.filter((entry) => entry.state === 'installed');
  const modern = installed.filter((entry) => entry.state === 'installed'
    && (entry.desiredScopes !== undefined || entry.actualState !== undefined));
  if (modern.length > 0) {
    return modern.map((entry) => {
      if (entry.state !== 'installed') return '';
      const desired = entry.desiredScopes?.map(scopeLabel).join('+') || scopeLabel(entry.scope);
      const actualScopes = [
        ...(entry.activation?.user ? ['所有项目'] : []),
        ...(entry.activation?.project ? ['当前项目'] : []),
      ];
      const actual = actualScopes.join('+') || scopeLabel(entry.scope);
      const state = entry.actualState === 'needsSync' ? '需同步'
        : entry.actualState === 'drifted' ? '已漂移'
          : entry.actualState === 'conflict' ? '冲突'
            : entry.actualState === 'ready' ? '可用' : aggregate.value;
      return `${platformLabel(entry.platform)} · desired ${desired} · actual ${actual} · ${state}`;
    }).join(' | ');
  }
  if (item.aggregateStatus !== 'ready') return aggregate.value;
  const ready = installed.filter((entry) => entry.state === 'installed' && entry.health === 'ready');
  const scopes = new Set(ready.map((entry) => entry.state === 'installed' ? entry.scope : undefined));
  return scopes.size === 1 && ready[0]?.state === 'installed'
    ? `${scopeLabel(ready[0].scope)} · ${aggregate.value}`
    : aggregate.value;
}

function dependentTargetLabel(item: PluginDependencyItemViewModel): string {
  const consumer = item.placementReferences?.[0]?.consumer;
  return consumer
    ? `${platformLabel(consumer.platform)} · ${scopeLabel(consumer.scope)}`
    : dependencyPlacementLabel(item);
}

function dependencyRelationDescription(item: PluginDependencyItemViewModel): string {
  if (item.relation === 'dependent') return '使用这个依赖的插件';
  const requiredBy = item.requiredBy.map((entry) => entry.displayName).join('、');
  return `${item.relation === 'direct' ? '直接依赖' : '间接依赖'}${requiredBy ? ` · ${requiredBy} 需要它` : ''}`;
}

function dependencySummaryText(summary: NonNullable<PluginListItemViewModel['dependencySummary']>): string {
  return `${summary.directCount} 个直接 · ${summary.totalCount} 个总计`;
}

function operationTargetStateLabel(
  state: 'completed' | 'kept' | 'failed' | 'skipped',
): { label: string; status: ActionItem['status'] } {
  const labels: Record<typeof state, { label: string; status: NonNullable<ActionItem['status']> }> = {
    completed: { label: '已完成', status: 'success' },
    kept: { label: '已保留', status: 'success' },
    failed: { label: '失败', status: 'error' },
    skipped: { label: '未执行 · 依赖未完成', status: 'warning' },
  };
  return labels[state];
}

function reviewSymbol(change: OperationReviewChange): string {
  return { add: '+', change: '~', remove: '−', keep: '✓', warning: '!' }[change.kind];
}

function currentPlugin(controller: TuiController, route: TuiRoute): PluginListItemViewModel | undefined {
  return 'pluginId' in route ? controller.getPluginOverview(route.pluginId) : undefined;
}

export function resolveConsoleV4ScreenId(
  snapshot: TuiControllerSnapshot,
  controller: TuiController,
  overlay?: Overlay,
  tooSmall = false,
  searchMode = false,
): ConsoleV4ScreenId {
  if (tooSmall) return 'G05';
  if (overlay === 'help') return 'G03';
  if (overlay === 'discard') return 'G04';
  if (snapshot.phase !== 'ready') return 'G01';
  const route = snapshot.router.current.route;
  if (route.name === 'home') return 'G02';
  if (route.name === 'pluginList') {
    const items = controller.listPlugins({ mode: route.mode, sourceId: route.sourceId });
    if (route.mode === 'installed' && items.length === 0) return 'P12';
    if (route.sourceId && controller.getSourceOverview(route.sourceId).source?.state === 'error') return 'P03';
    return route.mode === 'installed' ? 'P11' : searchMode ? 'P02' : 'P01';
  }
  if (route.name === 'pluginPreview') {
    return controller.getPluginOverview(route.pluginId)?.dependencySummary?.totalCount ? 'D01' : 'P04';
  }
  if (route.name === 'portableSkillSelect') return 'U01';
  if (route.name === 'portableDependencies') return 'U02';
  if (route.name === 'portableAgentMode') return 'U03';
  if (route.name === 'portableAgentInput') return 'U04';
  if (route.name === 'portableScope') return 'U05';
  if (route.name === 'portableBlocker') {
    if (route.code === 'requiredConfigMissing') return 'U09';
    if (route.code === 'portableSkillsCliMissing' || route.code === 'portableSkillsCliIncompatible') return 'U10';
    return 'U11';
  }
  if (route.name === 'pluginDependencies') {
    if (route.view === 'removeBlocked') return 'D12';
    const plugin = controller.getPluginOverview(route.pluginId);
    return plugin && hasInstalledPlacement(plugin) ? 'D10' : 'D02';
  }
  if (route.name === 'installPlacement') {
    return controller.getPluginOverview(route.pluginId)?.dependencySummary?.totalCount ? 'D03' : 'P05';
  }
  if (route.name === 'installTargets') {
    if (route.view === 'blocked') return 'D16';
    return controller.getPluginOverview(route.pluginId)?.dependencySummary?.totalCount ? 'D04' : 'P06';
  }
  if (route.name === 'dependencyPlacement') return 'D03';
  if (route.name === 'dependencyPlacementEditor') return 'D04';
  if (route.name === 'pluginDetail') {
    return controller.getPluginOverview(route.pluginId)?.dependencySummary?.totalCount ? 'D09' : 'P13';
  }
  if (route.name === 'platform') {
    const plugin = controller.getPluginOverview(route.pluginId);
    if (plugin?.aggregateStatus === 'unavailable') return 'P17';
    const placement = controller.getPlatformPlacement(route.pluginId, route.platform);
    if (!placement || placement.state === 'notInstalled') return 'P15';
    if (placement.state === 'installed' && placement.health === 'ready') return 'P14';
    return 'P16';
  }
  if (route.name === 'reviewPreparing') return 'P07';
  if (route.name === 'review' && snapshot.activeReview?.originIssue) return 'I10';
  const dependencyOperation = snapshot.activeReview?.operationKind === 'pluginWrite'
    && Boolean(snapshot.activeReview.changes.some((change) =>
      change.relation === 'direct' || change.relation === 'transitive'
      || change.group === 'dependencies'));
  if (route.name === 'review' && dependencyOperation) {
    return snapshot.activeReview?.pluginAction === 'uninstall' || snapshot.activeReview?.pluginAction === 'cleanup'
      ? 'D11' : 'D05';
  }
  if (route.name === 'progress' && snapshot.progressTargets.length > 0) return 'D06';
  if (route.name === 'result' && snapshot.result) {
    const dependencyTargets = snapshot.result.state === 'succeeded' || snapshot.result.state === 'partial'
      ? snapshot.result.summary.targets
      : snapshot.result.state === 'blocked' && snapshot.result.code === 'operationFailed'
        ? snapshot.result.summary?.targets : undefined;
    if (dependencyTargets?.some((target) => target.relation)) {
      return snapshot.result.state === 'succeeded' ? 'D07' : 'D08';
    }
  }
  if (route.name === 'progress' && snapshot.activeReview?.originIssue) return 'I11';
  if (route.name === 'result' && snapshot.result?.originIssue) {
    return snapshot.result.state === 'succeeded' ? 'I12' : 'I13';
  }
  if (route.name === 'review' && snapshot.activeReview?.operationKind === 'sourceMutation') {
    return ({ add: 'S10', update: 'S15', setPrimary: 'S16', remove: 'S18' } as const)[snapshot.activeReview.sourceAction!];
  }
  if (route.name === 'progress' && snapshot.activeReview?.operationKind === 'sourceMutation') return 'S11';
  if (route.name === 'result' && snapshot.result && 'operationKind' in snapshot.result
    && snapshot.result.operationKind === 'sourceMutation') {
    return snapshot.result.state === 'succeeded' ? 'S12' : 'S13';
  }
  if (route.name === 'review') return snapshot.activeReview?.operationKind === 'portableInstall' ? 'U06'
    : snapshot.activeReview?.operationKind === 'configSave'
    ? 'C12'
    : snapshot.activeReview?.operationKind === 'configReset'
      ? 'C16'
      : snapshot.activeReview?.operationKind === 'pluginWrite'
        && (snapshot.activeReview.pluginAction === 'upgrade' || snapshot.activeReview.pluginAction === 'reinstall')
        ? 'P18'
        : snapshot.activeReview?.operationKind === 'pluginWrite'
          && (snapshot.activeReview.pluginAction === 'uninstall' || snapshot.activeReview.pluginAction === 'cleanup')
          ? 'P19' : 'P07';
  if (route.name === 'progress') return snapshot.activeReview?.operationKind === 'portableInstall' ? 'U07'
    : snapshot.activeReview?.operationKind === 'configSave'
    || snapshot.activeReview?.operationKind === 'configReset' ? 'C13' : 'P08';
  if (route.name === 'result') return snapshot.result?.operationKind === 'portableInstall' ? 'U08'
    : snapshot.result?.operationKind === 'configSave'
    || snapshot.result?.operationKind === 'configReset'
    ? snapshot.result.state === 'succeeded' ? 'C14' : 'C15'
    : snapshot.result?.state === 'partial' ? 'P10' : 'P09';
  if (route.name === 'pluginAbout') return 'P20';
  if (route.name === 'pluginTechnical') return 'P21';
  if (route.name === 'configLayer') return 'C01';
  if (route.name === 'configFields') return route.layer.scope === 'effective' ? 'C02' : 'C03';
  if (route.name === 'configFieldAction') return 'C04';
  if (route.name === 'configFieldEditor') return {
    enum: 'C05', boolean: 'C06', number: 'C07', string: 'C08', path: 'C09', sensitive: 'C10',
  }[route.editor] as ConsoleV4ScreenId;
  if (route.name === 'configUnavailable') return 'C17';
  if (route.name === 'sourceList') return 'S01';
  if (route.name === 'sourceDetail') return 'K02';
  if (route.name === 'sourceTechnical') return 'S03';
  if (route.name === 'sourceAdd') return ({
    type: 'S04', id: 'S05', location: 'S06', refPolicy: 'S07', ref: 'S08', subdir: 'S09',
  } as const)[route.step];
  if (route.name === 'sourceEdit') return 'S14';
  if (route.name === 'sourceRemoveBlocked') return 'S17';
  if (route.name === 'issueList') {
    const issues = controller.listUserIssues();
    return issues.length === 0 ? 'I02' : issues.some((issue) => issue.category.startsWith('dependency')) ? 'D13' : 'I01';
  }
  if (route.name === 'issueDetail') {
    const category = controller.listUserIssues().find((issue) => issue.issueId === route.issueId)?.category;
    return {
      incompleteInstallation: 'I03',
      artifactCollision: 'I09',
      sourceUnavailable: 'I04',
      sourceMissing: 'I05',
      sourceIdentityChanged: 'I06',
      requiredConfigMissing: 'I07',
      scopeConflict: 'I08',
      dependencyMissing: 'D14',
      dependencyNotReady: 'D15',
      dependencyTargetUnsupported: 'D16',
      dependencyStillRequired: 'D12',
      dependencyGraphInvalid: 'D17',
      legacyState: 'I09',
      diagnostic: 'I09',
    }[category ?? 'diagnostic'] as ConsoleV4ScreenId;
  }
  return 'G02';
}

export interface ConsoleExitRequest {
  code: number;
  reason: 'user' | 'initialError' | 'completed' | 'partial' | 'blocked' | 'stale';
}

export function ConsoleAppV4(props: {
  controller: TuiController;
  size?: { columns: number; rows: number };
  onExit?: (request: ConsoleExitRequest) => void;
  onScreenChange?: (screen: ConsoleV4ScreenId) => void;
  ownsController?: boolean;
}): React.JSX.Element {
  const windowSize = useWindowSize();
  const size = props.size ?? windowSize;
  const policy = resolveTuiSizePolicy(size.columns, size.rows);
  const [snapshot, setSnapshot] = useState(props.controller.snapshot);
  const [overlay, setOverlay] = useState<Overlay>();
  const [overlayFocus, setOverlayFocus] = useState(0);
  const [discardForExit, setDiscardForExit] = useState(false);
  const [focus, setFocus] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [searchFocus, setSearchFocus] = useState(false);
  const [query, setQuery] = useState('');
  const [installFilter, setInstallFilter] = useState<PluginInstallFilter>(
    props.controller.snapshot.router.current.context.installFilter ?? 'all',
  );
  const [scope, setScope] = useState<Scope>('user');
  const [selectedTargets, setSelectedTargets] = useState<PlatformName[]>([]);
  const [targetSelections, setTargetSelections] = useState<Partial<Record<Scope, PlatformName[]>>>({});
  const [preferredTarget, setPreferredTarget] = useState<PlatformName>();
  const [technicalRouteKey, setTechnicalRouteKey] = useState<string>();
  const [exitAfterBusy, setExitAfterBusy] = useState(false);
  const [exitAfterPreparation, setExitAfterPreparation] = useState(false);
  const [, setClockTick] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [configPage, setConfigPage] = useState<ConfigPageViewModel>();
  const [configLayerCounts, setConfigLayerCounts] = useState<Record<string, number>>({});
  const [draftUpdates, setDraftUpdates] = useState<Record<string, string | number | boolean>>({});
  const [draftRemoves, setDraftRemoves] = useState<string[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [inputError, setInputError] = useState<string>();
  const [configActionError, setConfigActionError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [sourceDraft, setSourceDraft] = useState<SourceDraft>();
  const [sourceInput, setSourceInput] = useState('');
  const [sourceInputError, setSourceInputError] = useState<string>();
  const [sourceReferenceSummary, setSourceReferenceSummary] = useState<Awaited<ReturnType<TuiController['inspectSourceRemoval']>>>();
  const [sourceDependenciesExpanded, setSourceDependenciesExpanded] = useState(false);
  const [portableAgentInput, setPortableAgentInput] = useState('');
  const [draftOwner, setDraftOwner] = useState<string>();
  const [pendingPresetId, setPendingPresetId] = useState<string>();
  const [pendingLayerFieldKey, setPendingLayerFieldKey] = useState<string>();
  const [confirmedSharedReviewToken, setConfirmedSharedReviewToken] = useState<string>();
  const dynamicMenuFocus = useRef<DynamicMenuFocus | undefined>(undefined);
  const exitSent = useRef(false);
  const operationBusy = useRef(false);
  const route = snapshot.router.current.route;
  const routeKey = JSON.stringify(route);
  const showTechnical = technicalRouteKey === routeKey;
  const setShowTechnical = (next: boolean | ((current: boolean) => boolean)): void => {
    const visible = typeof next === 'function' ? next(showTechnical) : next;
    setTechnicalRouteKey(visible ? routeKey : undefined);
  };
  const plugin = currentPlugin(props.controller, route);
  const issue = route.name === 'issueDetail'
    ? props.controller.listUserIssues().find((entry) => entry.issueId === route.issueId)
    : undefined;
  const busy = route.name === 'progress';
  const preparationRunning = route.name === 'reviewPreparing'
    && snapshot.reviewPreparation?.state === 'running';
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => setClockTick((value) => value + 1), 1_000);
    return () => clearInterval(timer);
  }, [busy, route.name === 'progress' ? route.operationId : '']);
  const tooSmall = policy.mode === 'too-small';
  const requestExit = (request: ConsoleExitRequest): void => {
    if (exitSent.current) return;
    exitSent.current = true;
    props.onExit?.(request);
  };

  useEffect(() => {
    const unsubscribe = props.controller.subscribe(setSnapshot);
    if (props.controller.snapshot.phase === 'idle') {
      void props.controller.load().catch(() => {
        setActionError('操作未完成。请重新检查后重试。');
      });
    }
    return () => {
      unsubscribe();
      if (props.ownsController) props.controller.dispose();
    };
  }, [props.controller, props.ownsController]);

  useEffect(() => {
    if (!exitAfterBusy || !snapshot.result) return;
    const state = snapshot.result.state;
    requestExit({
      code: state === 'blocked' || state === 'partial' ? 1 : 0,
      reason: state === 'blocked' ? 'blocked' : state === 'partial' ? 'partial'
        : state === 'stale' ? 'stale' : 'completed',
    });
  }, [exitAfterBusy, snapshot.result]);
  useEffect(() => {
    if (!exitAfterPreparation || preparationRunning) return;
    requestExit({
      code: snapshot.reviewPreparation?.state === 'failed' ? 1 : 0,
      reason: snapshot.reviewPreparation?.state === 'failed' ? 'blocked' : 'user',
    });
  }, [exitAfterPreparation, preparationRunning, snapshot.reviewPreparation?.state]);
  useEffect(() => {
    if (route.name !== 'result'
      || !snapshot.result
      || (snapshot.result.state !== 'succeeded' && snapshot.result.state !== 'partial')
      || !snapshot.result.operationKind) return;
    setDirty(false);
    setDraftUpdates({});
    setDraftRemoves([]);
    if (snapshot.result.operationKind === 'sourceMutation') setSourceDraft(undefined);
  }, [route.name, snapshot.result]);
  useEffect(() => {
    if (route.name !== 'sourceAdd') setSourceInput('');
  }, [route.name]);
  useEffect(() => {
    if (route.name === 'portableAgentInput') {
      setPortableAgentInput(snapshot.portableDraft?.requestedAgents.join(' ') ?? '');
    } else setPortableAgentInput('');
  }, [route.name, route.name === 'portableAgentInput' ? snapshot.portableDraft?.requestedAgents.join('\0') : '']);
  useEffect(() => {
    if (route.name !== 'configFieldEditor') setInputValue('');
  }, [route.name]);
  const configRoute = route.name === 'configFields'
    || route.name === 'configFieldEditor'
    || route.name === 'configFieldAction'
    ? route
    : undefined;
  const currentConfigPage = configPageMatches(configPage, configRoute) ? configPage : undefined;
  useEffect(() => {
    if (route.name !== 'configLayer') return;
    const abort = new AbortController();
    const layers = [
      { key: 'user', layer: { scope: 'user' as const, projectLayer: 'shared' as const } },
      { key: 'project', layer: { scope: 'project' as const, projectLayer: 'shared' as const } },
      { key: 'local', layer: { scope: 'project' as const, projectLayer: 'local' as const } },
    ];
    void Promise.allSettled(layers.map(async ({ key, layer }) => ({
      key,
      count: (await props.controller.getConfigPage(route.pluginId, layer, abort.signal)).storedCount,
    }))).then((results) => {
      if (abort.signal.aborted) return;
      setConfigLayerCounts(Object.fromEntries(results.flatMap((result) =>
        result.status === 'fulfilled' ? [[result.value.key, result.value.count]] : [])));
    });
    return () => abort.abort();
  }, [props.controller, route.name, route.name === 'configLayer' ? route.pluginId : '']);
  useEffect(() => {
    if (!configRoute) return;
    const abort = new AbortController();
    const expectedPluginId = configRoute.pluginId;
    const expectedLayer = JSON.stringify(configRoute.layer);
    const owner = configOwnerKey(configRoute);
    setConfigPage(undefined);
    if (draftOwner !== owner) {
      setDraftOwner(owner);
      setDraftUpdates({});
      setDraftRemoves([]);
      setDirty(false);
      setConfigActionError(undefined);
    }
    void props.controller.getConfigPage(expectedPluginId, configRoute.layer, abort.signal)
      .then((page) => {
        if (abort.signal.aborted
          || expectedPluginId !== configRoute.pluginId
          || expectedLayer !== JSON.stringify(configRoute.layer)) return;
        setConfigPage(page);
      })
      .catch((error: unknown) => {
        if (!abort.signal.aborted) {
          const layer = configRoute.layer.scope === 'effective'
            ? undefined
            : { scope: configRoute.layer.scope as Scope, projectLayer: configRoute.layer.projectLayer };
          const code = typeof error === 'object' && error !== null && 'code' in error
            ? safeDiagnosticCode((error as { code?: unknown }).code, 'configUnavailable')
            : 'configUnavailable';
          props.controller.replace({
            name: 'configUnavailable',
            pluginId: expectedPluginId,
            diagnosticCode: code,
            diagnosticStage: 'read-config',
            ...(layer ? { layer } : {}),
          });
        }
      });
    return () => abort.abort();
  }, [configRoute?.pluginId, configRoute?.layer.scope, configRoute?.layer.projectLayer, props.controller]);

  useEffect(() => {
    if (route.name !== 'configFields' || !currentConfigPage) return;
    const tabs = configTabs(currentConfigPage);
    if (tabs.length === 0) return;
    const current = snapshot.router.current.context.configGroupId;
    if (tabs.some((tab) => tab.id === current)) return;
    props.controller.updatePageContext({ configGroupId: tabs[0]!.id });
  }, [props.controller, route.name, currentConfigPage, snapshot.router.current.context.configGroupId]);

  useEffect(() => {
    let count: number | undefined;
    if (route.name === 'sourceList') count = props.controller.listSources().length + 1;
    else if (route.name === 'issueList') {
      const issueCount = props.controller.listUserIssues().length;
      count = issueCount || 2;
    } else if (route.name === 'pluginList') {
      const itemCount = props.controller.listPlugins({
        mode: route.mode,
        ...(route.sourceId ? { sourceId: route.sourceId } : {}),
        ...(query ? { query } : {}),
        installFilter,
      }).length;
      count = itemCount || 1;
    }
    if (count === undefined) return;
    setFocus((value) => Math.min(value, Math.max(0, count - 1)));
    setScrollOffset((value) => Math.min(value, Math.max(0, count - 1)));
  }, [
    policy.mode,
    props.controller,
    query,
    installFilter,
    route.name,
    route.name === 'pluginList' ? route.mode : '',
    route.name === 'pluginList' ? route.sourceId : '',
    snapshot.viewModel,
  ]);

  const activeField = route.name === 'configFieldEditor' || route.name === 'configFieldAction'
    ? currentConfigPage?.groups.flatMap((group) => group.fields).find((field) => field.key === route.fieldKey)
    : undefined;
  useEffect(() => {
    if (route.name !== 'configFieldEditor' || !activeField) return;
    const draft = draftUpdates[activeField.key];
    setInputValue(route.editor === 'sensitive' || route.editor === 'path'
      ? draft === undefined ? '' : String(draft)
      : String(draft ?? activeField.value ?? ''));
    setInputError(undefined);
  }, [route.name, route.name === 'configFieldEditor' ? route.fieldKey : '', activeField?.key]);
  useEffect(() => {
    if (route.name !== 'sourceAdd') return;
    const draft = sourceDraft?.owner === route.owner ? sourceDraft : undefined;
    setSourceInput(route.step === 'id' ? draft?.sourceId ?? ''
      : route.step === 'location' ? draft?.location ?? ''
        : route.step === 'ref' ? draft?.ref ?? ''
          : route.step === 'subdir' ? draft?.subdir ?? '' : '');
    setSourceInputError(undefined);
  }, [route.name, route.name === 'sourceAdd' ? `${route.owner}:${route.step}` : '', sourceDraft?.owner]);
  useEffect(() => {
    if (route.name !== 'sourceRemoveBlocked') return;
    const abort = new AbortController();
    setSourceReferenceSummary(undefined);
    setSourceDependenciesExpanded(false);
    void props.controller.inspectSourceRemoval(route.sourceId)
      .then((summary) => { if (!abort.signal.aborted) setSourceReferenceSummary(summary); })
      .catch(() => { if (!abort.signal.aborted) setSourceReferenceSummary({ blocked: true, inventoryComplete: false, dependencies: [] }); });
    return () => abort.abort();
  }, [props.controller, route.name, route.name === 'sourceRemoveBlocked' ? route.sourceId : '']);

  const screenId = resolveConsoleV4ScreenId(
    snapshot,
    props.controller,
    overlay,
    tooSmall,
    searchFocus,
  );
  const portableVariantCandidates = route.name === 'portableSkillSelect' && snapshot.portableDraft
    ? snapshot.portableDraft.candidates.filter(portableScopeVariantsDiffer)
    : [];
  const supportsTechnicalDetails = Boolean(route.name === 'progress' && snapshot.progress.messages.length > 0)
    || Boolean(route.name === 'review' && snapshot.activeReview?.technicalDetails?.length)
    || Boolean(route.name === 'issueDetail' && issue
      && issue.diagnostic.technical)
    || Boolean(route.name === 'pluginDependencies' && plugin)
    || portableVariantCandidates.length > 0
    || Boolean(route.name === 'portableDependencies' && plugin
      && props.controller.getPluginDependencyOverview(plugin.pluginId)?.dependencies.length)
    || Boolean(route.name === 'portableBlocker' && plugin)
    || Boolean(route.name === 'configUnavailable' && plugin)
    || Boolean(route.name === 'result' && snapshot.result && 'operationKind' in snapshot.result
      && snapshot.result.operationKind === 'portableInstall');
  const canOpenHelp = !tooSmall
    && !isCharacterInputMode(route, searchFocus)
    && !(route.name === 'installTargets' && route.view !== 'blocked');
  useEffect(() => {
    props.onScreenChange?.(screenId);
  }, [props.onScreenChange, screenId]);

  const dependencyOverview = (candidate: PluginListItemViewModel | undefined): PluginDependencyOverviewViewModel | undefined =>
    candidate ? props.controller.getPluginDependencyOverview(candidate.pluginId) : undefined;

  let title = '管理你的 Agent 工作流插件';
  let description = '为 Codex 和 Claude Code 添加、设置或移除开发能力。';
  let breadcrumb = '首页';
  let context: string | undefined;
  let help = '↑↓ 移动 · Enter 选择 · ? 帮助 · q 退出';
  let content: React.ReactNode;
  let actions: ActionItem[] = [];
  let pluginRows: PluginListRowViewModel[] = [];
  let visibleConfigTabs: ConfigTab[] = [];
  let activeConfigTabId: string | undefined;
  const dynamicMenu = plugin && route.name === 'pluginPreview'
    ? buildPluginPreviewActions(plugin)
    : plugin && route.name === 'pluginDetail'
      ? buildPluginDetailActions(plugin)
      : plugin && route.name === 'platform'
        ? buildPlatformActions(plugin, route.platform)
        : undefined;
  const dynamicActionIds = dynamicMenu?.map(pluginMenuActionId);
  const dynamicActionSignature = dynamicActionIds?.join('\0');
  const previousDynamicFocus = dynamicMenuFocus.current;
  const retainedDynamicFocus = dynamicActionIds
    && previousDynamicFocus?.routeKey === routeKey
    && previousDynamicFocus.actionIds !== dynamicActionSignature
    && previousDynamicFocus.focusedActionId !== undefined
    ? dynamicActionIds.indexOf(previousDynamicFocus.focusedActionId)
    : -1;
  const effectiveFocus = dynamicActionIds
    && previousDynamicFocus?.routeKey === routeKey
    && previousDynamicFocus.actionIds !== dynamicActionSignature
    ? retainedDynamicFocus >= 0 ? retainedDynamicFocus : 0
    : focus;
  const pageActionBudget = (staticRows = 0): number => contentRowBudget({
    terminalRows: size.rows,
    description: Boolean(description),
    compact: policy.mode === 'compact',
    staticRows,
  });
  const dependencyPlacementStaticRows = policy.mode === 'compact' ? 3 : 10;
  const responsiveBudget = (compactRows: number, standardRows: number): number => {
    const baseline = policy.mode === 'compact' ? 18 : 24;
    const base = policy.mode === 'compact' ? compactRows : standardRows;
    return base + Math.max(0, size.rows - baseline);
  };

  const go = (next: TuiRoute): void => {
    props.controller.updatePageContext({ focusIndex: focus, scrollOffset, query, installFilter, sourceTabId: route.name === 'pluginList' ? route.sourceId ?? 'all' : undefined });
    props.controller.push(next);
    setFocus(0);
    setScrollOffset(0);
    setSearchFocus(false);
    setShowTechnical(false);
    setActionError(undefined);
  };
  const beginConfigFlow = (pluginId: string): void => {
    props.controller.updatePageContext({
      focusIndex: focus,
      scrollOffset,
      query,
      installFilter,
      sourceTabId: route.name === 'pluginList' ? route.sourceId ?? 'all' : undefined,
    });
    props.controller.beginConfigFlow(pluginId);
    setFocus(0);
    setScrollOffset(0);
    setSearchFocus(false);
    setShowTechnical(false);
    setActionError(undefined);
  };
  const back = (): void => {
    if (route.name === 'result') props.controller.leaveResult();
    else props.controller.back();
    const restored = props.controller.snapshot.router.current.context;
    setFocus(restored.focusIndex ?? 0);
    setScrollOffset(restored.scrollOffset ?? 0);
    setQuery(restored.query ?? '');
    setInstallFilter(restored.installFilter ?? 'all');
    setSearchFocus(false);
    setActionError(undefined);
  };
  const leaveResult = (target?: TuiRoute): void => {
    props.controller.leaveResult(target);
    const restored = props.controller.snapshot.router.current.context;
    setFocus(restored.focusIndex ?? 0);
    setScrollOffset(restored.scrollOffset ?? 0);
    setQuery(restored.query ?? '');
    setInstallFilter(restored.installFilter ?? 'all');
    setSearchFocus(false);
    setShowTechnical(false);
    setActionError(undefined);
  };
  const beginReview = (intent: OperationIntent): void => {
    const underlyingResultRoute = route.name === 'result' && snapshot.result && 'returnRoute' in snapshot.result
      ? snapshot.result.returnRoute
      : undefined;
    props.controller.updatePageContext({
      focusIndex: focus,
      scrollOffset,
      query,
      installFilter,
      sourceTabId: route.name === 'pluginList' ? route.sourceId ?? 'all' : undefined,
    });
    props.controller.startReviewPreparation(intent, underlyingResultRoute);
    setFocus(0);
    setScrollOffset(0);
  };
  const continueInstallAfterTargets = async (
    candidate: PluginListItemViewModel,
    targets: PlatformName[],
  ): Promise<void> => {
    if (props.controller.snapshot.installPlacementDraft?.pluginId !== candidate.pluginId) {
      props.controller.beginInstallFlow(candidate.pluginId, scope);
    }
    props.controller.setInstallPlatforms(targets);
    const hasConfigurableDependencies = await props.controller.prepareInstallDependencyPlacement();
    if (hasConfigurableDependencies) {
      go({ name: 'dependencyPlacement', pluginId: candidate.pluginId });
      return;
    }
    beginReview(props.controller.installPlacementIntent());
  };
  const beginPortable = async (pluginId: string): Promise<void> => {
    try {
      await props.controller.preparePortableInstall(
        pluginId,
        route.name === 'portableBlocker' ? 'replace' : 'push',
      );
      setFocus(0);
      setScrollOffset(0);
      setActionError(undefined);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') return;
      const blocker = extractPortableError(error);
      const target = { name: 'portableBlocker', pluginId, ...blocker } as const;
      if (props.controller.snapshot.router.current.route.name === 'portableBlocker') {
        props.controller.replace(target);
      } else {
        go(target);
      }
    }
  };
  const beginPortableReview = (pluginId: string, selectedScope: Scope): void => {
    props.controller.setPortableScope(selectedScope);
    try {
      props.controller.updatePageContext({ focusIndex: focus, scrollOffset });
      props.controller.startPortableInstallReviewPreparation();
      setFocus(0);
      setActionError(undefined);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') return;
      const blocker = extractPortableError(error);
      go({ name: 'portableBlocker', pluginId, ...blocker });
    }
  };
  const refreshPortableDraft = async (pluginId: string): Promise<boolean> => {
    try {
      await props.controller.refreshPortableInstallDraft(pluginId);
      return true;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') return false;
      const blocker = extractPortableError(error);
      const target = { name: 'portableBlocker', pluginId, ...blocker } as const;
      if (route.name === 'result') leaveResult(target);
      else props.controller.replace(target);
      setFocus(0);
      setScrollOffset(0);
      return false;
    }
  };
  const beginPluginRemoval = (
    candidate: PluginListItemViewModel,
    platform: PlatformName,
    selectedScope: Scope,
  ): void => {
    if (props.controller.getBlockingDependents(candidate.pluginId, platform, selectedScope).length > 0) {
      go({ name: 'pluginDependencies', pluginId: candidate.pluginId, view: 'removeBlocked',
        platform, scope: selectedScope });
      return;
    }
    void beginReview({
      kind: 'pluginWrite',
      action: 'uninstall',
      pluginId: candidate.pluginId,
      platform,
      scope: selectedScope,
    });
  };
  const beginSecondScope = (
    candidate: PluginListItemViewModel,
    platform: PlatformName,
    selectedScope: Scope,
  ): void => {
    setScope(selectedScope);
    setSelectedTargets([]);
    setTargetSelections({});
    setPreferredTarget(platform);
    props.controller.beginInstallFlow(candidate.pluginId, selectedScope);
    go({ name: 'installPlacement', pluginId: candidate.pluginId });
  };
  const beginScopeConflictRecovery = (
    action: Extract<PluginMenuAction, { id: 'resolveScopeConflict' }>,
  ): void => {
    void beginReview({
      kind: 'pluginWrite',
      action: 'uninstall',
      pluginId: action.pluginId,
      platform: action.platform,
      scope: action.scope,
      recoveryDescription: action.description,
    });
  };
  const beginAddSource = (): void => {
    const owner = `source-add:${Date.now()}`;
    setSourceDraft({ owner, mode: 'add', sourceId: '', type: 'git', location: '', refPolicy: 'cliChannel', ref: '', subdir: '' });
    setDirty(true);
    go({ name: 'sourceAdd', step: 'type', owner });
  };
  const beginIssueSourceAdd = (sourceId: string): void => {
    const owner = `source-readd:${sourceId}:${Date.now()}`;
    setSourceDraft({ owner, mode: 'add', sourceId, type: 'git', location: '', refPolicy: 'cliChannel', ref: '', subdir: '' });
    setDirty(true);
    go({ name: 'sourceAdd', step: 'type', owner });
  };
  const issueWriteIntent = (
    selectedIssue: UserIssueViewModel,
    action: UserIssueActionViewModel,
  ): OperationIntent | undefined => {
    const pluginId = action.pluginId ?? selectedIssue.pluginId;
    if (!pluginId || !selectedIssue.platform) return undefined;
    const selectedScope = action.id === 'keepUserScope'
      ? 'project'
      : action.id === 'keepProjectScope' ? 'user' : action.scope ?? selectedIssue.scope;
    const selectedPlatform = action.platform ?? selectedIssue.platform;
    const writeAction = action.writeAction ?? (action.id === 'reinstall'
      ? 'reinstall'
      : action.id === 'cleanup'
        ? 'cleanup'
        : action.id === 'remove' || action.id === 'keepUserScope' || action.id === 'keepProjectScope'
          ? 'uninstall'
          : undefined);
    if (!selectedScope || !selectedPlatform || !writeAction) return undefined;
    return {
      kind: 'pluginWrite',
      action: writeAction,
      pluginId,
      platform: selectedPlatform,
      scope: selectedScope,
      ...(selectedIssue.category === 'scopeConflict' && action.description
        ? { recoveryDescription: action.description }
        : {}),
      originIssue: {
        issueId: selectedIssue.issueId,
        issueKey: userIssueKey(selectedIssue),
        category: selectedIssue.category,
        actionId: action.id,
        ...(selectedIssue.category === 'dependencyMissing' || selectedIssue.category === 'dependencyNotReady'
          ? {
              consumerPluginId: selectedIssue.pluginId,
              consumerSourceIdentity: selectedIssue.sourceIdentity,
              consumerPlatform: selectedIssue.platform,
              consumerScope: selectedIssue.scope,
              dependencyPluginId: selectedIssue.dependencyPluginId,
              dependencyPlatform: selectedIssue.dependencyPlatform,
              dependencyScope: selectedIssue.dependencyScope,
              dependencyProject: selectedIssue.dependencyProject,
            }
          : {}),
      },
    };
  };
  const sourceFromDraft = (draft: SourceDraft): CatalogSource => draft.type === 'git'
    ? {
        id: draft.sourceId,
        type: 'git',
        primary: false,
        url: draft.location,
        refPolicy: draft.refPolicy === 'cliChannel' ? { type: 'cliChannel' } : { type: 'explicit', ref: draft.ref },
        ...(draft.subdir ? { subdir: draft.subdir } : {}),
      }
    : { id: draft.sourceId, type: 'path', primary: false, path: draft.location };
  const beginSourceAddReviewWith = async (draft: SourceDraft): Promise<void> => {
    const source = sourceFromDraft(draft);
    await beginReview({
      kind: 'sourceMutation', action: 'add', sourceId: source.id, source,
      changes: [
        { title: `添加来源 ${source.id}`, after: source.type === 'git' ? 'Git 仓库' : '本地目录' },
        { title: source.type === 'git' ? 'Git URL' : '本地目录', ...(source.type === 'git' ? { after: projectCatalogSourceLocation(source.url) } : { private: true }) },
        ...(source.type === 'git' ? [{ title: '版本引用', after: source.refPolicy.type === 'cliChannel' ? '跟随 AW 版本通道' : source.refPolicy.ref }] : []),
        ...(source.type === 'git' && source.subdir ? [{ title: 'Catalog 子目录', after: source.subdir }] : []),
      ],
    });
  };
  const beginSourceUpdateReview = async (draft: SourceDraft): Promise<void> => {
    const detail = props.controller.getSourceOverview(draft.sourceId).detail;
    if (!detail || !draft.editField) return;
    const update = draft.type === 'path'
      ? { type: 'path' as const, path: draft.location }
      : draft.editField === 'location'
        ? { type: 'git' as const, url: draft.location }
        : draft.editField === 'refPolicy'
          ? { type: 'git' as const, refPolicy: draft.refPolicy === 'cliChannel' ? { type: 'cliChannel' as const } : { type: 'explicit' as const, ref: draft.ref } }
          : { type: 'git' as const, subdir: draft.subdir || null };
    const change = draft.editField === 'location'
      ? { title: draft.type === 'git' ? 'Git URL' : '本地目录', before: detail.locationSummary, ...(draft.type === 'git' ? { after: projectCatalogSourceLocation(draft.location) } : { private: true }) }
      : draft.editField === 'refPolicy'
        ? { title: '版本引用', before: detail.refPolicy === 'explicit' ? detail.explicitRef : '跟随 AW 版本通道', after: draft.refPolicy === 'explicit' ? draft.ref : '跟随 AW 版本通道' }
        : { title: 'Catalog 子目录', before: detail.subdir ?? '未设置', after: draft.subdir || '未设置' };
    await beginReview({ kind: 'sourceMutation', action: 'update', sourceId: draft.sourceId, update, changes: [change] });
  };
  const configLayerLabel = (layer: { scope: Scope | 'effective'; projectLayer: 'shared' | 'local' }): string =>
    layer.scope === 'effective' ? '有效设置'
      : layer.scope === 'user' ? '个人默认'
        : layer.projectLayer === 'local' ? '当前项目（仅本机）' : '当前项目';
  const currentFieldDisplay = (field: ConfigFieldViewModel): string => {
    if (draftRemoves.includes(field.key)) return '恢复继承';
    if (Object.hasOwn(draftUpdates, field.key)) {
      const value = draftUpdates[field.key];
      if (field.sensitive) return '将更新';
      if (field.type === 'enum') return field.valueLabels?.[String(value)] ?? String(value);
      if (field.type === 'boolean') return value ? '开启' : '关闭';
      return `${String(value)}${field.unit ? ` ${field.unit}` : ''}`;
    }
    if (field.type === 'enum' && field.value !== undefined) {
      return field.valueLabels?.[String(field.value)] ?? field.displayValue;
    }
    if (field.type === 'boolean' && field.value !== undefined) return field.value ? '开启' : '关闭';
    return `${field.displayValue}${field.unit && field.displayValue !== '未设置' ? ` ${field.unit}` : ''}`;
  };
  const effectiveFieldDisplay = (field: ConfigFieldViewModel): string => {
    if (field.type === 'enum' && field.effectiveValue !== undefined) {
      return field.valueLabels?.[String(field.effectiveValue)] ?? field.effectiveDisplayValue;
    }
    if (field.type === 'boolean' && field.effectiveValue !== undefined) {
      return field.effectiveValue ? '开启' : '关闭';
    }
    return `${field.effectiveDisplayValue}${field.unit && field.effectiveDisplayValue !== '未设置' ? ` ${field.unit}` : ''}`;
  };
  const fieldEditor = (field: ConfigFieldViewModel): Extract<TuiRoute, { name: 'configFieldEditor' }>['editor'] => {
    if (field.sensitive) return 'sensitive';
    return field.type;
  };
  const updateDraft = (key: string, value: string | number | boolean): void => {
    setConfigActionError(undefined);
    const field = currentConfigPage?.groups.flatMap((group) => group.fields)
      .find((candidate) => candidate.key === key);
    const unchanged = field?.configured === true && field.value === value;
    setDraftUpdates((current) => {
      const next = { ...current };
      if (unchanged) delete next[key];
      else next[key] = value;
      const nextRemoves = draftRemoves.filter((candidate) => candidate !== key);
      setDraftRemoves(nextRemoves);
      setDirty(Object.keys(next).length + nextRemoves.length > 0);
      return next;
    });
  };
  const removeDraft = (key: string): void => {
    setConfigActionError(undefined);
    setDraftUpdates((current) => {
      const next = { ...current };
      delete next[key];
      const field = currentConfigPage?.groups.flatMap((group) => group.fields)
        .find((candidate) => candidate.key === key);
      const nextRemoves = field?.configured
        ? [...new Set([...draftRemoves, key])]
        : draftRemoves.filter((candidate) => candidate !== key);
      setDraftRemoves(nextRemoves);
      setDirty(Object.keys(next).length + nextRemoves.length > 0);
      return next;
    });
  };
  const cancelDraftRemoval = (key: string): void => {
    const nextRemoves = draftRemoves.filter((candidate) => candidate !== key);
    setDraftRemoves(nextRemoves);
    setDirty(Object.keys(draftUpdates).length + nextRemoves.length > 0);
    setConfigActionError(undefined);
  };
  const configFieldTarget = (page: ConfigPageViewModel, key: string | undefined): {
    groupId: string;
    focusIndex: number;
  } | undefined => {
    if (!key) return undefined;
    for (const group of page.groups) {
      const focusIndex = group.fields.findIndex((field) => field.key === key);
      if (focusIndex >= 0) return { groupId: group.id, focusIndex };
    }
    return undefined;
  };
  const applyConfigPreset = (page: ConfigPageViewModel, presetId: string): void => {
    const preset = page.presets.find((candidate) => candidate.id === presetId);
    if (!preset) return;
    const fields = new Map(page.groups.flatMap((group) => group.fields)
      .map((field) => [field.key, field]));
    setDraftUpdates((current) => {
      const next = { ...current };
      for (const [key, value] of Object.entries(preset.values)) {
        const field = fields.get(key);
        if (field?.configured && field.value === value) delete next[key];
        else next[key] = value;
      }
      const nextRemoves = draftRemoves.filter((key) => !Object.hasOwn(preset.values, key));
      setDraftRemoves(nextRemoves);
      setDirty(Object.keys(next).length + nextRemoves.length > 0);
      return next;
    });
    const target = configFieldTarget(page, Object.keys(preset.values)[0])
      ?? (page.groups[0] ? { groupId: page.groups[0].id, focusIndex: 0 } : undefined);
    if (target) {
      props.controller.updatePageContext({
        configGroupId: target.groupId,
        focusIndex: target.focusIndex,
        scrollOffset: 0,
      });
      setFocus(target.focusIndex);
      setScrollOffset(0);
    }
    setConfigActionError((preset.privateFieldTitles?.length ?? 0) > 0
      ? `${preset.privateFieldTitles!.join('、')}需手动输入。`
      : undefined);
  };
  const openConfigLayerTarget = (
    layer: { scope: Scope; projectLayer: 'shared' | 'local' },
  ): void => {
    if (route.name !== 'configLayer') return;
    const field = route.fieldKey && configPage
      ? configPage.groups.flatMap((group) => group.fields).find((candidate) => candidate.key === route.fieldKey)
      : undefined;
    const fieldTarget = configPage ? configFieldTarget(configPage, route.fieldKey) : undefined;
    const preset = route.presetId && configPage
      ? configPage.presets.find((candidate) => candidate.id === route.presetId)
      : undefined;
    const presetTarget = preset
      ? configFieldTarget(configPage!, Object.keys(preset.values)[0])
      : undefined;
    const target = fieldTarget ?? (route.groupId ? { groupId: route.groupId, focusIndex: 0 } : undefined) ?? presetTarget
      ?? (configPage?.groups[0] ? { groupId: configPage.groups[0].id, focusIndex: 0 } : undefined);
    const context = target
      ? { configGroupId: target.groupId, focusIndex: target.focusIndex, scrollOffset: 0 }
      : {};
    props.controller.replace({ name: 'configFields', pluginId: route.pluginId, layer }, context);
    if (route.presetId) {
      setPendingPresetId(route.presetId);
      setFocus(target?.focusIndex ?? 0);
      setScrollOffset(0);
      return;
    }
    if (field && route.fieldKey) setPendingLayerFieldKey(route.fieldKey);
    setFocus(0);
    setScrollOffset(0);
  };
  const configChanges = (): NonNullable<Extract<OperationIntent, { kind: 'configSave' }>['changes']> => {
    const fields = currentConfigPage?.groups.flatMap((group) => group.fields) ?? [];
    return [...Object.keys(draftUpdates), ...draftRemoves.filter((key) => !Object.hasOwn(draftUpdates, key))]
      .map((key) => {
        const field = fields.find((candidate) => candidate.key === key)!;
        return {
          key,
          title: field?.title ?? key,
          before: field?.displayValue ?? '未设置',
          after: draftRemoves.includes(key)
            ? `恢复继承（${field?.fallbackDisplayValue ?? '未设置'} · ${field?.fallbackSourceLabel ?? '未设置'}）`
            : currentFieldDisplay(field),
        };
      });
  };
  const beginConfigSave = async (): Promise<void> => {
    if (!configRoute || configRoute.layer.scope === 'effective' || !currentConfigPage || !dirty) return;
    const fields = currentConfigPage.groups.flatMap((group) => group.fields);
    try {
      await beginReview({
        kind: 'configSave',
        pluginId: configRoute.pluginId,
        scope: configRoute.layer.scope,
        projectLayer: configRoute.layer.projectLayer,
        updates: draftUpdates,
        removeKeys: draftRemoves,
        sensitiveKeys: fields.filter((field) => field.sensitive).map((field) => field.key),
        privateKeys: [],
        changes: configChanges(),
      });
      setConfigActionError(undefined);
    } catch {
      setConfigActionError('设置值未通过验证。请重新检查修改。');
    }
  };
  useEffect(() => {
    if (!pendingLayerFieldKey || route.name !== 'configFields'
      || route.layer.scope === 'effective' || !currentConfigPage) return;
    const field = currentConfigPage.groups.flatMap((group) => group.fields)
      .find((candidate) => candidate.key === pendingLayerFieldKey);
    setPendingLayerFieldKey(undefined);
    if (!field) return;
    const layer = { scope: route.layer.scope as Scope, projectLayer: route.layer.projectLayer };
    props.controller.push(field.configured ? {
      name: 'configFieldAction',
      pluginId: route.pluginId,
      layer,
      fieldKey: field.key,
    } : {
      name: 'configFieldEditor',
      pluginId: route.pluginId,
      layer,
      fieldKey: field.key,
      editor: fieldEditor(field),
    });
  }, [pendingLayerFieldKey, route.name, currentConfigPage]);
  useEffect(() => {
    if (!pendingLayerFieldKey) return;
    if (route.name === 'configFields' && route.layer.scope !== 'effective') return;
    if (route.name === 'configLayer') return;
    setPendingLayerFieldKey(undefined);
  }, [pendingLayerFieldKey, route.name]);
  useEffect(() => {
    if (!pendingPresetId || route.name !== 'configFields'
      || route.layer.scope === 'effective' || !currentConfigPage) return;
    const presetId = pendingPresetId;
    setPendingPresetId(undefined);
    applyConfigPreset(currentConfigPage, presetId);
  }, [pendingPresetId, route.name, currentConfigPage]);
  useEffect(() => {
    if (!pendingPresetId) return;
    if (route.name === 'configFields' && route.layer.scope !== 'effective') return;
    setPendingPresetId(undefined);
  }, [pendingPresetId, route.name, route.name === 'configFields' ? route.layer.scope : '']);

  if (snapshot.phase === 'error') {
    breadcrumb = '启动失败';
    title = '无法读取插件状态';
    description = snapshot.loadError?.message ?? '当前不能安全显示插件状态。';
    help = 'q 退出 · Ctrl-C 退出';
    content = <StatusCard status="error" title={snapshot.loadError?.code ?? 'statusLoadFailed'} description="没有执行任何写操作。" />;
  } else if (snapshot.phase !== 'ready') {
    breadcrumb = '启动';
    title = '正在检查插件状态';
    description = '单个来源失败不会阻止其他来源继续加载。';
    help = 'Ctrl-C 完成后退出';
    content = <StatusCard status="info" title="准备控制台">
      <ProgressRow title="读取插件来源" state="active" />
      <ProgressRow title="检查当前项目" state="pending" />
      <ProgressRow title="汇总可用操作" state="pending" />
    </StatusCard>;
  } else if (route.name === 'home') {
    const home = snapshot.viewModel!.home;
    context = '当前项目';
    actions = [
      { label: '添加插件', description: '浏览多个来源中的 Agent 能力', meta: String(home.availablePlugins), run: () => go({ name: 'pluginList', mode: 'browse' }) },
      { label: '我的插件', description: '查看状态、设置和移除已添加插件', meta: String(home.installedPlugins), run: () => go({ name: 'pluginList', mode: 'installed' }) },
      { label: '需要处理', description: '解决安装、来源或设置问题', meta: String(home.issueCount), status: 'warning', run: () => go({ name: 'issueList' }) },
      { label: '插件来源', description: '管理 Git 仓库和本地目录', meta: String(home.sourceCount), run: () => go({ name: 'sourceList' }) },
    ];
    content = <Box flexDirection="column">
      <StatusCard
        status={home.issueCount > 0 || home.unavailableSourceCount > 0 ? 'warning' : 'success'}
        title="当前状态"
      >
        <ResultRow title={`${home.installedPlugins} 个插件可用`} status="success" />
        <ResultRow title={`${home.issueCount} 项需要处理`} status={home.issueCount > 0 ? 'warning' : 'muted'} />
        {home.unavailableSourceCount > 0 ? <ResultRow title={`${home.unavailableSourceCount} 个来源不可用`} status="error" /> : null}
      </StatusCard>
      <SemanticRows actions={actions} focus={focus} kind="task" compact={policy.mode === 'compact'} />
    </Box>;
  } else if (route.name === 'pluginList') {
    const sourceId = route.sourceId ?? 'all';
    const items = props.controller.listPlugins({
      mode: route.mode,
      ...(sourceId !== 'all' ? { sourceId } : {}),
      ...(query ? { query } : {}),
      installFilter,
    });
    const uninstalledCount = props.controller.listPlugins({
      mode: route.mode,
      ...(sourceId !== 'all' ? { sourceId } : {}),
      ...(query ? { query } : {}),
      installFilter: 'uninstalled',
    }).length;
    breadcrumb = route.mode === 'browse' ? '添加插件' : '我的插件';
    title = breadcrumb;
    description = route.mode === 'browse' ? '选择希望 Agent 获得的能力。' : '查看状态，或选择一个插件进行管理。';
    context = `${items.length} 个插件`;
    help = `↑↓ 移动 · Enter 查看 · ←→ 来源 · / 搜索${route.mode === 'browse' ? ' · f 未安装' : ''} · Esc 返回`;
    const sourceError = sourceId !== 'all' && props.controller.getSourceOverview(sourceId).source?.state === 'error';
    actions = sourceError
      ? [{ label: '查看来源问题', description: '当前不能浏览这个来源', run: () => go({ name: 'issueDetail', issueId: `source:${sourceId}:unavailable` }) }]
      : [];
    pluginRows = sourceError ? [] : items.map((item) => ({
      pluginId: item.pluginId,
      name: item.displayName,
      sourceLabel: item.sourceLabel,
      description: item.primaryAttention
        ? `${item.primaryAttention.code} · ${item.primaryAttention.message}`
        : item.description,
      placementSummary: pluginPlacementSummary(item),
      statusLabel: statusText(item),
      status: pluginRowStatus(item),
    }));
    if (route.mode === 'installed' && items.length === 0 && !sourceError) {
      title = '还没有添加插件';
      description = `从已配置的 ${props.controller.listSources().length} 个来源中浏览可用能力。`;
      actions = [{ label: '浏览插件', description: '开始添加第一个插件', run: () => go({ name: 'pluginList', mode: 'browse' }) }];
    } else if (route.mode === 'browse' && items.length === 0 && !sourceError) {
      actions = [{
        label: '没有匹配插件',
        description: installFilter === 'uninstalled'
          ? '当前来源和搜索条件下没有未安装插件；按 f 查看全部，或按 / 编辑搜索'
          : '按 / 编辑搜索，或切换来源',
        disabled: '没有可打开的插件',
      }];
    }
    const pluginListStaticRows = route.mode === 'browse' ? 3 : 2;
    const viewport = sourceError || pluginRows.length === 0
      ? actionViewport(actions, policy.mode === 'compact', focus, scrollOffset, pageActionBudget(pluginListStaticRows))
      : rowViewport({
          rowHeights: pluginRows.map(() => 3),
          focus,
          requestedOffset: scrollOffset,
          rowBudget: pageActionBudget(pluginListStaticRows),
        });
    if (viewport.hiddenBefore > 0 || viewport.hiddenAfter > 0) {
      context = `${items.length} 个插件 · ${viewport.position}/${viewport.total}`;
    }
    content = (
      <Box flexDirection="column">
        <SourceTabs
          controller={props.controller}
          current={sourceId}
          compact={policy.mode === 'compact'}
          columns={size.columns - 2}
          mode={route.mode}
          query={query || undefined}
          installFilter={installFilter}
        />
        <Text color={searchFocus ? tuiTheme.colors.accent : tuiTheme.colors.muted}>搜索  / {searchFocus
          ? <InputDisplay value={query} placeholder="输入搜索内容" columns={Math.max(8, size.columns - 14)} />
          : <>{query || '搜索名称、用途或来源…'}{query ? '    / 编辑' : ''}</>}</Text>
        {route.mode === 'browse'
          ? <Text color={tuiTheme.colors.muted}>状态  <Text color={installFilter === 'all' ? tuiTheme.colors.accent : tuiTheme.colors.muted}>{installFilter === 'all' ? '[全部]' : '全部'}</Text>  <Text color={installFilter === 'uninstalled' ? tuiTheme.colors.accent : tuiTheme.colors.muted}>{installFilter === 'uninstalled' ? '[未安装]' : '未安装'} {uninstalledCount}</Text>                         f 切换</Text>
          : null}
        {sourceError
          ? <Callout status="error" title={`${sourceId} 暂时无法提供插件`} description="当前不能浏览这个来源。" />
          : route.mode === 'installed' && items.length === 0
            ? <Callout title="开始添加第一个插件" description="插件可以安装到 Codex、Claude Code 或两者。" />
            : null}
        {pluginRows.length > 0
          ? <PluginRows rows={pluginRows} focus={focus} viewport={viewport} />
          : <SemanticRows actions={actions} focus={focus} kind="action" compact={policy.mode === 'compact'} offset={viewport.offset} limit={viewport.limit} />}
      </Box>
    );
  } else if (route.name === 'pluginPreview' && plugin) {
    breadcrumb = `添加插件 / ${plugin.displayName}`;
    context = plugin.sourceLabel;
    title = `${plugin.displayName}${plugin.version ? `  ${plugin.version}` : ''}`;
    description = plugin.description;
    const overview = dependencyOverview(plugin);
    const hasDependencies = (plugin.dependencySummary?.totalCount ?? 0) > 0;
    const beginInstall = (): void => {
      const initialScope = (['user', 'project'] as const).find((candidateScope) =>
        props.controller.listInstallTargets(plugin.pluginId, candidateScope)
          .some((entry) => entry.compatible)) ?? scope;
      const available = props.controller.listInstallTargets(plugin.pluginId, initialScope)
        .filter((entry) => entry.compatible).map((entry) => entry.platform);
      setScope(initialScope);
      setSelectedTargets([]);
      setTargetSelections({});
      setPreferredTarget(undefined);
      props.controller.beginInstallFlow(plugin.pluginId, initialScope);
      if (available.length > 0) go({ name: 'installPlacement', pluginId: plugin.pluginId });
      else go({ name: 'installTargets', pluginId: plugin.pluginId, view: 'blocked' });
    };
    const previewAction = (action: PluginMenuAction): ActionItem => {
      if (action.id === 'add') return { label: '添加插件', description: '选择使用位置并确认变化', run: beginInstall };
      if (action.id === 'manage') return { label: '管理插件', description: '查看已安装目标平台', run: () => go({ name: 'pluginDetail', pluginId: plugin.pluginId }) };
      if (action.id === 'repair') return { label: '管理并修复', description: '查看需要处理的安装位置', status: 'warning', run: () => go({ name: 'pluginDetail', pluginId: plugin.pluginId }) };
      if (action.id === 'portableSkills') return { label: '安装通用 Skills…', description: '选择 Skill 和 Agent 后交给 Skills CLI 安装', run: () => beginPortable(plugin.pluginId) };
      if (action.id === 'dependencies') return {
        label: (overview?.blockers.length ?? 0) > 0 ? '查看依赖问题' : '查看依赖关系',
        description: overview?.blockers[0]?.explanation ?? '查看直接、间接依赖和当前状态',
        ...((overview?.blockers.length ?? 0) > 0 ? { status: 'warning' as const } : {}),
        run: () => go({ name: 'pluginDependencies', pluginId: plugin.pluginId }),
      };
      if (action.id === 'settings') return { label: '查看插件设置', description: `${plugin.configFieldCount} 个配置字段及当前来源`, run: () => beginConfigFlow(plugin.pluginId) };
      if (action.id === 'sourceProblem') return { label: '查看来源问题', status: 'warning', run: () => go({ name: 'sourceDetail', sourceId: plugin.sourceId }) };
      if (action.id === 'outputCollision') {
        const collision = props.controller.listUserIssues().find((issue) =>
          issue.pluginId === plugin.pluginId && issue.category === 'artifactCollision');
        return {
          label: '查看输出冲突',
          description: '目标位置已有不属于当前插件的内容',
          status: 'error',
          run: () => collision
            ? go({ name: 'issueDetail', issueId: collision.issueId })
            : go({ name: 'pluginTechnical', pluginId: plugin.pluginId }),
        };
      }
      if (action.id === 'about') return { label: '关于', run: () => go({ name: 'pluginAbout', pluginId: plugin.pluginId }) };
      return { label: '查看来源', run: () => go({ name: 'sourceDetail', sourceId: plugin.sourceId }) };
    };
    const previewMenu = dynamicMenu!;
    actions = previewMenu.map(previewAction);
    const previewViewport = actionViewport(actions, true, effectiveFocus, scrollOffset, responsiveBudget(4, 2));
    const dependencyGroups = (['direct', 'transitive'] as const).map((relation) => ({
      relation,
      dependencies: (overview?.dependencies.filter((entry) => entry.relation === relation) ?? [])
        .sort((left, right) => {
          const priority = (entry: PluginDependencyItemViewModel): number => {
            const status = dependencyStatus(entry).status;
            return status === 'error' ? 0 : status === 'warning' ? 1 : 2;
          };
          return priority(left) - priority(right);
        }),
    }));
    const previewContentLines = size.rows - 6;
    const previewActionLines = previewViewport.limit ?? actions.length;
    const previewFixedStaticLines = 7 + (plugin.portableSkills && policy.mode !== 'compact' ? 5 : 0);
    let dependencyLineBudget = Math.max(
      dependencyGroups.filter((group) => group.dependencies.length > 0).length,
      previewContentLines - previewActionLines - previewFixedStaticLines,
    );
    const visibleByRelation = new Map<'direct' | 'transitive', number>();
    for (const group of dependencyGroups) {
      if (group.dependencies.length === 0) continue;
      const firstItemLines = policy.mode === 'compact' || group.dependencies.length > 1 ? 1 : 2;
      const hiddenSummaryLines = group.dependencies.length > 1 ? 1 : 0;
      if (dependencyLineBudget >= firstItemLines + hiddenSummaryLines) {
        visibleByRelation.set(group.relation, 1);
        dependencyLineBudget -= firstItemLines + hiddenSummaryLines;
      } else {
        visibleByRelation.set(group.relation, 0);
        dependencyLineBudget -= 1;
      }
    }
    for (const group of dependencyGroups) {
      let visibleCount = visibleByRelation.get(group.relation) ?? 0;
      while (dependencyLineBudget > 0 && visibleCount < group.dependencies.length) {
        visibleCount += 1;
        dependencyLineBudget -= 1;
      }
      visibleByRelation.set(group.relation, visibleCount);
    }
    const summaryRows = (relation: 'direct' | 'transitive'): React.ReactNode[] => {
      const dependencies = dependencyGroups.find((group) => group.relation === relation)!.dependencies;
      const visibleCount = policy.mode === 'compact' ? Math.min(1, dependencies.length)
        : visibleByRelation.get(relation) ?? 0;
      const visible = dependencies.slice(0, visibleCount);
      const compactRows = policy.mode === 'compact' || dependencies.length > visible.length;
      return [
        ...visible.map((entry) => {
          const state = dependencyStatus(entry);
          return <StaticRow
            key={entry.pluginId}
            title={entry.displayName}
            description={dependencyRelationDescription(entry)}
            meta={state.value}
            status={state.status}
            compact={compactRows}
          />;
        }),
        ...(visible.length === 0 && dependencies.length > 0
          ? [<StaticRow key={`${relation}:count`} title={`${dependencies.length} 个${relation === 'direct' ? '直接' : '间接'}依赖`} status="muted" compact />]
          : dependencies.length > visible.length
          ? [<StaticRow key={`${relation}:more`} title={`另有 ${dependencies.length - visible.length} 个${relation === 'direct' ? '直接' : '间接'}依赖`} status="muted" compact />]
          : []),
      ];
    };
    const compactDependencyRows = overview?.dependencies.slice(0, 2) ?? [];
    content = hasDependencies
      ? <Box flexDirection="column">
          {plugin.portableSkills && policy.mode !== 'compact' ? <SectionCard title="可用方式"><StaticRow title="通用 Skills" meta={`可安装 · ${plugin.dependencySummary!.totalCount} 个插件依赖`} description="选择 Skill 和 Agent 后交给 Skills CLI 安装" /></SectionCard> : null}
          <SectionCard title="安装内容">
            {policy.mode !== 'compact' ? <StaticRow title={plugin.displayName} description="你选择的插件" status="info" /> : null}
            {plugin.portableSkills && policy.mode === 'compact' ? <StaticRow title="通用 Skills" meta={`可安装 · ${plugin.dependencySummary!.totalCount} 个插件依赖`} compact /> : null}
            {policy.mode === 'compact' ? compactDependencyRows.map((entry) => {
              const state = dependencyStatus(entry);
              return <StaticRow key={entry.pluginId} title={entry.displayName} meta={`${entry.relation === 'direct' ? '直接' : '间接'} · ${state.value}`} status={state.status} compact />;
            }) : <>{summaryRows('direct')}{summaryRows('transitive')}</>}
            {policy.mode === 'compact' && (overview?.dependencies.length ?? 0) > compactDependencyRows.length ? <StaticRow title={`另有 ${(overview?.dependencies.length ?? 0) - compactDependencyRows.length} 个依赖`} status="muted" compact /> : null}
            {policy.mode !== 'compact' ? <StaticRow title={`${plugin.dependencySummary!.totalCount + 1} 个插件将作为一个安装计划检查`} description="依赖从同一个来源快照解析。" /> : null}
          </SectionCard>
          <SemanticRows actions={actions} focus={effectiveFocus} kind="action" compact={policy.mode === 'compact' || previewViewport.limit !== undefined} offset={previewViewport.offset} limit={previewViewport.limit} />
        </Box>
      : <Box flexDirection="column"><SectionCard title="可用目标平台"><StaticRow title={plugin.supportedPlatforms.map(platformLabel).join(' · ') || '暂无可用目标平台'} />{plugin.portableSkills ? <StaticRow title="通用 Skills" meta="可安装" description="选择 Skill 和 Agent 后交给 Skills CLI 安装" compact={policy.mode === 'compact'} /> : null}</SectionCard><SectionCard title="使用说明"><StaticRow title="在 Agent 会话中提供能力" status="success" description="安装不会自动修改项目源码。" /></SectionCard><SemanticRows actions={actions} focus={effectiveFocus} kind="action" compact={policy.mode === 'compact'} offset={previewViewport.offset} limit={previewViewport.limit} /></Box>;
  } else if (route.name === 'portableSkillSelect' && plugin && snapshot.portableDraft) {
    const draft = snapshot.portableDraft;
    breadcrumb = `${plugin.displayName} / 通用 Skills`;
    context = `${draft.selectedCount} / ${draft.totalCount} 已选择`;
    title = '选择要安装的 Skills';
    description = '已根据插件依赖和当前设置准备候选；默认全部选择。';
    const candidateActions: ActionItem[] = draft.candidates.map((candidate) => ({
      label: candidate.name,
      selected: candidate.selected,
      description: `${candidate.description}${candidate.dynamic ? ' · 按设置生成' : ''}`,
      run: () => props.controller.togglePortableSkill(candidate.name),
    }));
    actions = [
      ...candidateActions,
      { label: '继续', meta: draft.canContinue ? undefined : '至少选择一个 Skill', disabled: draft.canContinue ? undefined : '至少选择一个 Skill', run: () => go({ name: 'portableAgentMode', pluginId: plugin.pluginId }) },
      ...(plugin.dependencySummary?.totalCount ? [{ label: '查看依赖关系', run: () => go({ name: 'portableDependencies', pluginId: plugin.pluginId }) }] : []),
    ];
    const candidateViewport = portableSkillCandidateViewport(
      candidateActions,
      draft.candidates,
      policy.mode === 'compact',
      focus,
      scrollOffset,
      pageActionBudget(
        actions.length - draft.candidates.length
        + (portableVariantCandidates.length > 0 ? 3 : 0),
      ),
    );
    const viewport = showTechnical
      ? { offset: focus < draft.candidates.length ? focus : candidateViewport.offset, limit: 1 }
      : candidateViewport;
    const visibleCandidateEntries = draft.candidates
      .map((candidate, index) => ({ candidate, action: candidateActions[index]!, index }))
      .slice(viewport.offset, viewport.offset + viewport.limit);
    const providerGroups = [...new Map(visibleCandidateEntries.map((entry) => [
      entry.candidate.providerPluginId,
      visibleCandidateEntries.filter((candidate) => candidate.candidate.providerPluginId === entry.candidate.providerPluginId),
    ])).values()];
    const variantCandidates = portableVariantCandidates;
    const focusedVariant = variantCandidates.find((candidate) => candidate.name === draft.candidates[focus]?.name);
    const visibleVariant = visibleCandidateEntries.find((entry) => portableScopeVariantsDiffer(entry.candidate))?.candidate;
    const technicalVariant = focusedVariant ?? visibleVariant ?? variantCandidates[0];
    help = '↑↓ 移动 · Space 切换 · a 全选 · Enter 继续 · Esc 返回';
    content = <Box flexDirection="column">
      {showTechnical ? visibleCandidateEntries.map(({ action, index }) => <ToggleRow
        key={String(action.label)}
        title={action.label}
        selected={Boolean(action.selected)}
        focused={focus === index}
        compact
      />) : providerGroups.map((entries) => {
        const provider = entries[0]!.candidate;
        const relation = provider.relation === 'requested' ? '当前插件'
          : provider.relation === 'direct' ? '直接依赖插件' : '间接依赖插件';
        return <SectionCard key={provider.providerPluginId} title={provider.providerDisplayName} meta={relation} compact={policy.mode === 'compact'}>
          {entries.map(({ action, index }) => <ToggleRow
            key={String(action.label)}
            title={action.label}
            description={action.description}
            selected={Boolean(action.selected)}
            focused={focus === index}
            compact={policy.mode === 'compact'}
          />)}
        </SectionCard>;
      })}
      {variantCandidates.length > 0
        ? showTechnical
          ? <StaticRow title={`! ${variantCandidates.length} 个 Skill 存在范围变体`} status="warning" compact />
          : <Callout status="warning" title={`! ${variantCandidates.length} 个 Skill 在不同安装范围会生成不同内容。选择范围后会重新确认最终内容。`} />
        : null}
      <SemanticRows actions={actions} focus={focus} kind="action" compact offset={draft.candidates.length} />
      {showTechnical && technicalVariant ? <TechnicalDetails title="范围变体">
        <StaticRow key={`${technicalVariant.name}:project`} title={`${technicalVariant.name} · ${portableScopeVariantLabel('project', technicalVariant.scopeDetails.project)}`} compact />
        <StaticRow key={`${technicalVariant.name}:user`} title={`${technicalVariant.name} · ${portableScopeVariantLabel('user', technicalVariant.scopeDetails.user)}`} compact />
        {variantCandidates.length > 1 ? <StaticRow title={`另有 ${variantCandidates.length - 1} 个 Skill 的范围变体已折叠`} status="muted" compact /> : null}
      </TechnicalDetails> : null}
    </Box>;
  } else if (route.name === 'portableDependencies' && plugin && snapshot.portableDraft) {
    const overview = dependencyOverview(plugin);
    breadcrumb = `${plugin.displayName} / 通用 Skills / 依赖`;
    context = `${(overview?.summary.totalCount ?? 0) + 1} 个插件`;
    title = '生成这些候选 Skills 需要的插件';
    description = '插件依赖用于生成，不能在这里取消。';
    actions = [
      { label: '返回 Skill 选择', run: back },
      { label: showTechnical ? '隐藏技术详情' : '技术详情', run: () => setShowTechnical((value) => !value) },
    ];
    const dependencies = overview?.dependencies ?? [];
    const visibleDependencies = dependencies.slice(0, showTechnical ? 1 : responsiveBudget(2, 3));
    const technicalDependencies = dependencies.slice(0, 1);
    const compactTechnicalSummary = policy.mode === 'compact' && showTechnical;
    content = <Box flexDirection="column">
      {compactTechnicalSummary ? <SectionCard title="provider 摘要" meta={`${dependencies.length + 1} 个`} compact>
        <StaticRow title={plugin.displayName} meta="根 provider" compact />
        <StaticRow title={`${dependencies.length} 个依赖 providers`} meta="用于生成" compact />
      </SectionCard> : <SectionCard title="当前插件" meta="根 provider"><StaticRow title={plugin.displayName} description="提供本次安装入口" meta={`贡献 ${snapshot.portableDraft.candidates.filter((candidate) => candidate.relation === 'requested').length} 个 Skills`} compact={policy.mode === 'compact'} /></SectionCard>}
      {compactTechnicalSummary ? null : <SectionCard title="依赖 providers" meta={`${dependencies.length} 个`}>
        {visibleDependencies.map((dependency) => <StaticRow key={dependency.pluginId} title={dependency.displayName} description={`${dependency.relation === 'direct' ? '根 provider 的直接依赖' : '依赖链中的间接 provider'} · ${dependency.requiredBy.map((entry) => entry.displayName).join('、')} 需要它`} meta={`贡献 ${snapshot.portableDraft!.candidates.filter((candidate) => candidate.providerPluginId === dependency.pluginId).length} 个 Skills`} compact={policy.mode === 'compact'} />)}
        {dependencies.length > visibleDependencies.length ? <StaticRow title={`另有 ${dependencies.length - visibleDependencies.length} 个依赖 provider`} status="muted" compact /> : null}
      </SectionCard>}
      <SemanticRows actions={actions} focus={focus} kind="action" compact />
      {showTechnical ? <TechnicalDetails>{technicalDependencies.map((entry) => <StaticRow key={entry.pluginId} title={entry.displayName} meta={`${entry.pluginId}${compactTechnicalSummary && dependencies.length > technicalDependencies.length ? ` · 另有 ${dependencies.length - technicalDependencies.length} 个依赖` : ''}`} compact />)}</TechnicalDetails> : null}
    </Box>;
  } else if (route.name === 'portableAgentMode' && plugin && snapshot.portableDraft) {
    breadcrumb = `${plugin.displayName} / 通用 Skills / Agent`;
    title = '安装到哪些 Agent？';
    description = '可以自动选择检测到的 Agent，也可以限制到指定 Agent。';
    actions = [
      { label: '使用 Skills CLI 默认选择', description: '继续 Skills CLI 默认选择', meta: '默认', selected: snapshot.portableDraft.agentMode === 'automatic', run: () => { props.controller.setPortableAgentMode('automatic'); go({ name: 'portableScope', pluginId: plugin.pluginId }); } },
      { label: '指定 Agent…', description: '输入一个或多个 Agent ID', selected: snapshot.portableDraft.agentMode === 'explicit', run: () => go({ name: 'portableAgentInput', pluginId: plugin.pluginId }) },
    ];
    content = <SemanticRows actions={actions} focus={focus} kind="choice" compact={policy.mode === 'compact'} />;
  } else if (route.name === 'portableAgentInput' && plugin) {
    breadcrumb = `${plugin.displayName} / 通用 Skills / Agent`;
    context = '指定';
    title = '输入 Agent ID';
    description = '多个 Agent 可使用逗号或空格分隔。';
    help = '输入 Agent ID · Enter 保存 · Esc 返回';
    content = <Box flexDirection="column"><InputCard focused title={<InputDisplay value={portableAgentInput} columns={Math.max(8, size.columns - 8)} />} description={inputError ?? 'Enter 保存并继续 · Esc 返回；q 和 b 会作为输入。'} status={inputError ? 'error' : undefined} /><StaticRow title="示例" meta="cursor, claude-code, codex" status="muted" compact /></Box>;
  } else if (route.name === 'portableScope' && plugin && snapshot.portableDraft) {
    breadcrumb = `${plugin.displayName} / 通用 Skills / 范围`;
    title = '在哪里使用这些 Skills？';
    description = `已选择 ${snapshot.portableDraft.selectedCount} 个 Skills · Agent：${snapshot.portableDraft.agentMode === 'automatic' ? '自动选择' : snapshot.portableDraft.requestedAgents.join('、')}`;
    actions = [
      { label: '当前项目', description: '仅供当前项目中的 Agent 使用', meta: '推荐', selected: snapshot.portableDraft.scope === 'project', run: () => props.controller.setPortableScope('project') },
      { label: '所有项目', description: '安装到用户范围，供所有项目使用', selected: snapshot.portableDraft.scope === 'user', run: () => props.controller.setPortableScope('user') },
      { label: '继续', description: '按所选范围重新确认最终内容', run: () => beginPortableReview(plugin.pluginId, snapshot.portableDraft!.scope) },
    ];
    content = <Box flexDirection="column"><SemanticRows actions={actions.slice(0, 2)} focus={focus} kind="choice" compact={policy.mode === 'compact'} /><SemanticRows actions={actions} focus={focus} kind="action" compact offset={2} /></Box>;
  } else if (route.name === 'portableBlocker' && plugin) {
    breadcrumb = `${plugin.displayName} / 通用 Skills`;
    const diagnostic = portableBlockerDiagnostic(route);
    title = diagnostic.title;
    description = '';
    actions = [
      ...(route.code === 'requiredConfigMissing' ? [{ label: '完成插件设置', run: () => {
        props.controller.replace({ name: 'configLayer', pluginId: plugin.pluginId });
        setFocus(0);
        setScrollOffset(0);
      } }] : []),
      ...(route.code === 'portableSkillsCliMissing' || route.code === 'portableSkillsCliIncompatible'
        ? [{ label: showTechnical ? '返回问题摘要' : '查看安装说明', run: () => setShowTechnical((value) => !value) }]
        : []),
      ...(route.code === 'portableScopeUnavailable' ? [{ label: '返回 Skill 选择', run: () => {
        props.controller.resetPortableFlowToPreview(
          plugin.pluginId,
          { name: 'portableSkillSelect', pluginId: plugin.pluginId },
          true,
        );
        setFocus(0);
        setScrollOffset(0);
      } }] : []),
      { label: '重新检查', run: () => beginPortable(plugin.pluginId) },
      { label: '返回插件预览', run: () => props.controller.resetPortableFlowToPreview(plugin.pluginId) },
      ...(route.code === 'portableSkillsCliMissing' || route.code === 'portableSkillsCliIncompatible'
        ? []
        : [{ label: showTechnical ? '返回问题摘要' : '技术详情', run: () => setShowTechnical((value) => !value) }]),
    ];
    const blockerActionViewport = actionViewport(actions, policy.mode === 'compact', focus, scrollOffset, responsiveBudget(2, 4));
    content = <Box flexDirection="column">
      <DiagnosticSummary diagnostic={diagnostic} technical={showTechnical} compact={policy.mode === 'compact'} />
      <SemanticRows actions={actions} focus={focus} kind="action" compact={policy.mode === 'compact'} offset={blockerActionViewport.offset} limit={blockerActionViewport.limit} />
    </Box>;
  } else if (route.name === 'pluginDependencies' && plugin) {
    const overview = dependencyOverview(plugin);
    const visibleDependents = route.view === 'removeBlocked' && route.platform && route.scope
      ? props.controller.getBlockingDependents(plugin.pluginId, route.platform, route.scope)
      : overview?.dependents ?? [];
    const dependencyCount = overview?.dependencies.length ?? 0;
    const dependentCount = visibleDependents.length;
    const dependencyLimit = policy.mode === 'compact'
      ? dependentCount > 0 ? 1 : 2
      : dependentCount > 0 ? 3 : 5;
    const dependentLimit = responsiveBudget(2, 4);
    const dependencyRows = (entries: PluginDependencyItemViewModel[], limit: number, dependent = false): React.ReactNode => {
      const visible = entries.slice(0, limit);
      return <>
        {visible.map((entry) => {
          const state = dependencyStatus(entry);
          return <StaticRow
            key={entry.pluginId}
            title={entry.displayName}
            description={dependencyRelationDescription(entry)}
            meta={dependent && route.view === 'removeBlocked' ? dependentTargetLabel(entry) : dependencyPlacementLabel(entry)}
            status={state.status}
            compact={policy.mode === 'compact'}
          />;
        })}
        {entries.length > visible.length ? <StaticRow title={`另有 ${entries.length - visible.length} 项`} status="muted" compact /> : null}
      </>;
    };
    if (route.view === 'removeBlocked') {
      breadcrumb = `${plugin.displayName} / 移除`;
      context = '已阻止';
      title = `无法移除 ${plugin.displayName}`;
      description = '仍有插件依赖它。请先处理依赖者，再重新尝试。';
      actions = [
        ...(route.platform && route.scope ? [{
          label: '强制清理…',
          description: '依赖者会变为不完整；下一页仍需明确确认',
          status: 'error' as const,
          run: () => beginReview({
            kind: 'pluginWrite',
            action: 'cleanup',
            pluginId: plugin.pluginId,
            platform: route.platform!,
            scope: route.scope!,
            force: true,
          }),
        }] : []),
        { label: '查看完整依赖关系', run: () => {
          props.controller.replace({ name: 'pluginDependencies', pluginId: plugin.pluginId });
          setFocus(0);
          setScrollOffset(0);
        } },
        { label: '返回插件详情', run: back },
        { label: showTechnical ? '隐藏技术详情' : '技术详情', run: () => setShowTechnical((value) => !value) },
      ];
      const blockedRemovalViewport = actionViewport(actions, policy.mode === 'compact', focus, scrollOffset, pageActionBudget(5));
      content = <Box flexDirection="column">
        <Callout status="error" title={`${dependentCount} 个已安装插件仍在使用`} description="没有修改任何安装。" />
        {showTechnical ? null : <SectionCard title="使用这个依赖的插件" meta="反向引用">
          {dependencyRows(visibleDependents, dependentLimit, true)}
        </SectionCard>}
        <SemanticRows actions={actions} focus={focus} kind="action" compact={policy.mode === 'compact'} offset={blockedRemovalViewport.offset} limit={blockedRemovalViewport.limit} />
        {showTechnical ? <IssueTechnicalDetails details={[{
          code: 'dependencyStillRequired',
          message: '已安装插件仍在使用这个依赖；强制清理会使依赖者变为不完整。',
        }]} compact={policy.mode === 'compact'} /> : null}
      </Box>;
    } else {
      breadcrumb = `${plugin.displayName} / 依赖关系`;
      context = overview ? `${overview.summary.totalCount + 1} 个插件` : '只读';
      title = hasInstalledPlacement(plugin) ? '依赖与被使用情况' : '安装所需插件';
      description = '依赖由同一来源快照解析；调整前会进入 Review。';
      const installedTargets = plugin.installedPlacements.filter((placement): placement is Extract<PlatformPlacementSummary, { state: 'installed' }> =>
        placement.state === 'installed');
      actions = [
        ...(hasInstalledPlacement(plugin) && dependencyCount > 0 && installedTargets.length > 0 ? [{
          label: '调整依赖位置…',
          description: '按平台设置 project/user；不会自动清理所有项目内容',
          run: async () => {
            const rootScope: Scope = installedTargets.some((placement) =>
              placement.desiredScopes?.includes('project') || placement.scope === 'project')
              ? 'project' : 'user';
            const platforms = [...new Set(installedTargets.map((placement) => placement.platform))];
            setScope(rootScope);
            setSelectedTargets(platforms);
            props.controller.beginInstallFlow(plugin.pluginId, rootScope, { adjustingExisting: true });
            props.controller.setInstallPlatforms(platforms);
            const configurable = await props.controller.prepareInstallDependencyPlacement();
            if (!configurable) {
              setActionError('当前依赖位置都由约束固定，没有可调整项。');
              return;
            }
            go({ name: 'dependencyPlacement', pluginId: plugin.pluginId });
          },
        }] : []),
        { label: '技术详情', description: '显示 canonical pluginId 和安全错误代码', run: () => setShowTechnical((value) => !value) },
      ];
      const rootStatus = plugin.aggregateStatus === 'installed' ? 'success' as const
        : plugin.aggregateStatus === 'needsAttention' ? 'warning' as const
          : plugin.aggregateStatus === 'unavailable' ? 'error' as const : 'muted' as const;
      const dependencyActionViewport = actionViewport(actions, policy.mode === 'compact', focus, scrollOffset, pageActionBudget(6));
      const blockerCount = overview?.blockers.length ?? 0;
      const useBudgetedRelations = policy.mode === 'compact'
        || showTechnical
        || dependencyCount + dependentCount + blockerCount > 7;
      const relationCategories = [
        ...(blockerCount > 0 ? [{ key: 'blocker' as const, count: blockerCount }] : []),
        ...(dependencyCount > 0 ? [{ key: 'dependency' as const, count: dependencyCount }] : []),
        ...(dependentCount > 0 ? [{ key: 'dependent' as const, count: dependentCount }] : []),
      ];
      const technicalLineBudget = showTechnical ? 4 : 0;
      const relationItemBudget = Math.max(
        relationCategories.length,
        size.rows - 6 - 1 - technicalLineBudget - 4,
      );
      const relationBudgets = new Map(relationCategories.map((category) => [category.key, 1]));
      let remainingRelationLines = Math.max(0, relationItemBudget - relationCategories.length);
      for (const category of relationCategories) {
        if (category.key === 'blocker') continue;
        while (remainingRelationLines > 0 && (relationBudgets.get(category.key) ?? 0) < category.count) {
          relationBudgets.set(category.key, (relationBudgets.get(category.key) ?? 0) + 1);
          remainingRelationLines -= 1;
        }
      }
      const prioritizedRelations = (entries: PluginDependencyItemViewModel[]): PluginDependencyItemViewModel[] =>
        [...entries].sort((left, right) => {
          const priority = (entry: PluginDependencyItemViewModel): number => {
            const status = dependencyStatus(entry).status;
            return status === 'error' ? 0 : status === 'warning' ? 1 : 2;
          };
          return priority(left) - priority(right);
        });
      const budgetedRelationRows = (
        entries: PluginDependencyItemViewModel[],
        prefix: string,
        budget: number,
        dependent = false,
      ): React.ReactNode => {
        const prioritized = prioritizedRelations(entries);
        const visible = prioritized.slice(0, budget);
        return visible.map((entry, index) => {
          const state = dependencyStatus(entry);
          const hidden = index === visible.length - 1 ? entries.length - visible.length : 0;
          const relationMeta = dependent ? dependentTargetLabel(entry) : dependencyPlacementLabel(entry);
          return <StaticRow
            key={entry.pluginId}
            title={`${prefix} · ${entry.displayName}`}
            description={dependencyRelationDescription(entry)}
            meta={`${relationMeta}${hidden > 0 ? ` · 另有 ${hidden} 项` : ''}`}
            status={state.status}
            compact
          />;
        });
      };
      content = <Box flexDirection="column">
        {useBudgetedRelations ? <SectionCard title="依赖关系" compact>
          <StaticRow title={`根插件 · ${plugin.displayName}`} meta={statusText(plugin)} status={rootStatus} compact />
          {overview?.blockers.slice(0, relationBudgets.get('blocker') ?? 0).map((blocker, index, blockers) => <StaticRow
            key={blocker.code}
            title={`阻塞 · ${blocker.title}`}
            meta={index === blockers.length - 1 && blockerCount > blockers.length ? `另有 ${blockerCount - blockers.length} 项` : undefined}
            description={blocker.explanation}
            status="error"
            compact
          />)}
          {budgetedRelationRows(overview?.dependencies ?? [], '必需依赖', relationBudgets.get('dependency') ?? 0)}
          {budgetedRelationRows(visibleDependents, '被依赖', relationBudgets.get('dependent') ?? 0, true)}
          {dependencyCount + dependentCount + blockerCount === 0 ? <StaticRow title="没有可显示的依赖关系" status="muted" compact /> : null}
        </SectionCard> : <>
          <SectionCard title="你选择的插件" meta="根节点"><StaticRow title={plugin.displayName} meta={statusText(plugin)} status={rootStatus} /></SectionCard>
          {dependencyCount > 0 ? <SectionCard title="必需依赖" meta="依赖优先">{dependencyRows(overview?.dependencies ?? [], dependencyLimit)}</SectionCard> : null}
          {dependentCount > 0 ? <SectionCard title="使用它的插件" meta="反向引用">{dependencyRows(visibleDependents, dependentLimit, true)}</SectionCard> : null}
          {overview?.blockers.map((blocker) => <Callout key={blocker.code} status="error" title={blocker.title} description={blocker.explanation} />)}
          {dependencyCount + dependentCount + blockerCount === 0 ? <Callout status="muted" title="没有可显示的依赖关系" /> : null}
        </>}
        <SemanticRows actions={actions} focus={focus} kind="action" compact={useBudgetedRelations} offset={dependencyActionViewport.offset} limit={dependencyActionViewport.limit} />
        {showTechnical ? <TechnicalDetails>
          <StaticRow title={`${dependencyCount} 依赖 · ${dependentCount} 被依赖 · 已折叠`} meta={plugin.pluginId} compact />
        </TechnicalDetails> : null}
      </Box>;
    }
  } else if (route.name === 'installPlacement' && plugin) {
    breadcrumb = `${plugin.displayName} / 添加`;
    context = '第 1 步，共 2 步';
    title = `你希望在哪里使用 ${plugin.displayName}？`;
    const hasDependencies = (plugin.dependencySummary?.totalCount ?? 0) > 0;
    description = hasDependencies
      ? '这里只选择根插件位置。依赖可以在下一步单独调整；依赖不能比根插件位置更窄。'
      : '选择位置后，再选择一个或多个目标平台。';
    const availableScopes = (['user', 'project'] as const).filter((candidateScope) =>
      props.controller.listInstallTargets(plugin.pluginId, candidateScope)
        .some((entry) => entry.compatible));
    actions = [
      ...availableScopes.map((candidateScope) => ({
        label: scopeLabel(candidateScope),
        selected: candidateScope === scope,
        description: candidateScope === 'user'
          ? hasDependencies ? '根插件在任意项目中可用；依赖位置下一步确认' : '在任意项目中可使用，适合个人常用能力'
          : hasDependencies ? '根插件只在当前项目使用；依赖可单独调整为所有项目' : '仅在当前项目中使用，适合团队共享',
        meta: candidateScope === 'user' ? '推荐' : undefined,
        run: () => {
          const choices = props.controller.listInstallTargets(plugin.pluginId, candidateScope);
          const compatible = choices.filter((entry) => entry.compatible).map((entry) => entry.platform);
          const previous = targetSelections[candidateScope];
          const next = previous
            ? previous.filter((platform) => compatible.includes(platform))
            : preferredTarget && compatible.includes(preferredTarget)
              ? [preferredTarget]
              : compatible.length === 1 ? compatible : [];
          setScope(candidateScope);
          setSelectedTargets(next);
          setTargetSelections((current) => ({ ...current, [candidateScope]: next }));
          props.controller.setInstallRootScope(candidateScope);
          go({
            name: 'installTargets',
            pluginId: plugin.pluginId,
            ...(compatible.length === 0 ? { view: 'blocked' as const } : {}),
          });
        },
      })),
    ];
    content = <Box flexDirection="column">
      <SemanticRows actions={actions} focus={focus} kind="choice" compact={policy.mode === 'compact'} />
      {hasDependencies ? <SectionCard title="依赖位置"><StaticRow title={`${plugin.dependencySummary?.totalCount ?? 0} 个依赖将在下一步单独确认`} status="info" /></SectionCard> : null}
    </Box>;
  } else if (route.name === 'installTargets' && plugin) {
    breadcrumb = `${plugin.displayName} / 添加 / 目标平台`;
    context = '第 2 步，共 2 步';
    title = '选择目标平台';
    const hasDependencies = (plugin.dependencySummary?.totalCount ?? 0) > 0;
    description = hasDependencies
      ? '根插件必须支持所选位置；每个依赖必须至少有一个合法位置。'
      : '目标平台按所选位置验证；仅含 Codex native 的插件可同时启用两个位置。';
    const choices = props.controller.listInstallTargets(plugin.pluginId, scope);
    const validSelectedTargets = selectedTargets.filter((platform) =>
      choices.some((choice) => choice.platform === platform && choice.compatible));
    const allUnavailable = choices.length > 0 && choices.every((choice) => !choice.compatible);
    if (route.view === 'blocked' || allUnavailable) {
      context = '依赖限制';
      title = '无法添加到所选目标平台';
      description = '根插件或必需依赖不支持当前目标平台组合，因此不会进入确认页。';
      actions = [
        { label: '查看依赖关系', run: () => go({ name: 'pluginDependencies', pluginId: plugin.pluginId }) },
        { label: '返回调整位置', run: back },
      ];
      content = <Box flexDirection="column"><StatusCard status="warning" title="所选目标平台不可用">{choices.map((choice) => <StaticRow key={choice.platform} title={platformLabel(choice.platform)} description={choice.disabled ? `不可选 · ${choice.disabled}` : '不可选'} status="muted" compact={policy.mode === 'compact'} />)}</StatusCard><SemanticRows actions={actions} focus={focus} kind="action" compact={policy.mode === 'compact'} /></Box>;
    } else {
      const targetActions = choices.map((choice) => ({
        label: platformLabel(choice.platform),
        selected: validSelectedTargets.includes(choice.platform),
        description: choice.disabled ?? '当前未安装，支持所选位置',
        meta: validSelectedTargets.includes(choice.platform) ? '已选择' : undefined,
        disabled: choice.disabled,
        run: () => {
          if (!choice.compatible) return;
          setSelectedTargets((current) => {
            const next = current.includes(choice.platform)
              ? current.filter((platform) => platform !== choice.platform)
              : [...current, choice.platform];
            setTargetSelections((selections) => ({ ...selections, [scope]: next }));
            props.controller.setInstallPlatforms(next);
            return next;
          });
        },
      }));
      actions = [
        ...targetActions,
        {
          label: '确认目标平台',
          description: validSelectedTargets.length > 0 ? `已选择 ${validSelectedTargets.length} 个平台` : undefined,
          disabled: validSelectedTargets.length === 0 ? '至少选择一个目标平台' : undefined,
          run: () => {
            setDirty(false);
            if (!hasDependencies) {
              if (props.controller.snapshot.installPlacementDraft?.pluginId !== plugin.pluginId) {
                props.controller.beginInstallFlow(plugin.pluginId, scope);
              }
              props.controller.setInstallPlatforms(validSelectedTargets);
              beginReview(props.controller.installPlacementIntent());
              return;
            }
            return continueInstallAfterTargets(plugin, validSelectedTargets);
          },
        },
        { label: '返回选择位置', run: back },
      ];
      help = '↑↓ 移动 · Enter 选择/确认 · Esc 返回';
      content = <Box flexDirection="column">
        <SemanticRows
          actions={actions}
          focus={focus}
          kind="toggle"
          compact={policy.mode === 'compact'}
          limit={targetActions.length}
        />
        {hasDependencies ? <Callout title="目标平台兼容性" description="不兼容的目标平台不能选择；请查看依赖关系了解原因。" /> : null}
        <SemanticRows
          actions={actions}
          focus={focus}
          kind="action"
          compact={policy.mode === 'compact'}
          offset={targetActions.length}
        />
      </Box>;
    }
  } else if (route.name === 'dependencyPlacement' && plugin) {
    const draft = snapshot.installPlacementDraft?.pluginId === plugin.pluginId
      ? snapshot.installPlacementDraft : undefined;
    breadcrumb = `${plugin.displayName} / 添加 / 依赖位置`;
    context = '依赖位置';
    title = '选择每个平台的依赖位置';
    description = '每个直接或间接依赖都可独立设置。所有项目位置更宽，会影响其他项目和你的用户环境。';
    const dependencyActions: ActionItem[] = (draft?.targets ?? []).map((target) => ({
      label: `${target.displayName} · ${platformLabel(target.platform)}`,
      description: `${target.relation === 'direct' ? '直接依赖' : '间接依赖'} · ${target.explanation}`,
      meta: `${scopeLabel(target.scope)}${target.assignmentSource === 'consumerPromotion' ? ' · fixed-point 提升' : ''}`,
      selected: true,
      disabled: target.locked ? '位置由平台或上游约束固定' : undefined,
      run: () => go({
        name: 'dependencyPlacementEditor',
        pluginId: plugin.pluginId,
        dependencyPluginId: target.pluginId,
        platform: target.platform,
      }),
    }));
    actions = [
      ...dependencyActions,
      {
        label: '继续到确认',
        description: draft?.canContinue ? '使用这些最终位置准备 Review' : undefined,
        disabled: !draft?.canContinue ? draft?.error?.message ?? '依赖位置尚未就绪' : undefined,
        run: () => beginReview(props.controller.installPlacementIntent()),
      },
      {
        label: '恢复推荐位置',
        description: '恢复默认、健康 user 复用和 fixed-point 计算结果',
        run: () => props.controller.resetDependencyScopes(),
      },
      { label: '返回目标平台', run: back },
    ];
    const placementViewport = actionViewport(
      actions,
      policy.mode === 'compact',
      focus,
      scrollOffset,
      pageActionBudget(dependencyPlacementStaticRows),
    );
    const userCount = draft?.targets.filter((target) => target.scope === 'user').length ?? 0;
    const defaultCount = draft?.targets.filter((target) =>
      target.assignmentSource === 'default').length ?? 0;
    const reusedCount = draft?.targets.filter((target) =>
      target.assignmentSource === 'existingWiderTarget').length ?? 0;
    const promotedCount = draft?.targets.filter((target) =>
      target.assignmentSource === 'consumerPromotion').length ?? 0;
    const reasonSummary = [
      ...(defaultCount > 0 ? [`默认 project ${defaultCount} 项`] : []),
      ...(reusedCount > 0 ? [`复用健康的所有项目安装 ${reusedCount} 项`] : []),
      ...(promotedCount > 0 ? [`fixed-point 提升 ${promotedCount} 项`] : []),
    ].join('；');
    content = <Box flexDirection="column">
      {policy.mode === 'compact'
        ? <>
            <StaticRow title={`根插件 · ${plugin.displayName}`} meta={draft ? scopeLabel(draft.rootScope) : '未就绪'} compact />
            <StaticRow title={`位置原因 · ${reasonSummary || '由平台或上游约束固定'}`} status={userCount > 0 ? 'warning' : 'info'} compact />
            <StaticRow title="范围提示 · 所有项目位置会影响其他项目和用户环境" status={userCount > 0 ? 'warning' : 'muted'} compact />
          </>
        : <>
            <SectionCard title="根插件位置">
              <StaticRow title={plugin.displayName} meta={draft ? scopeLabel(draft.rootScope) : '未就绪'} compact />
            </SectionCard>
            <Callout
              status={userCount > 0 ? 'warning' : 'info'}
              title={userCount > 0 ? `${userCount} 个依赖平台目标使用所有项目位置` : '位置计算原因'}
              description={`${reasonSummary || '依赖位置由平台或上游约束固定'}${userCount > 0 ? '；所有项目位置对其他项目也可见，并会改变你的用户环境' : ''}。`}
            />
          </>}
      <SemanticRows actions={actions} focus={focus} kind="action" compact={policy.mode === 'compact'} offset={placementViewport.offset} limit={placementViewport.limit} />
    </Box>;
    help = '↑↓ 移动 · Enter 打开/继续 · Esc 返回';
  } else if (route.name === 'dependencyPlacementEditor' && plugin) {
    const target = snapshot.installPlacementDraft?.targets.find((entry) =>
      entry.pluginId === route.dependencyPluginId && entry.platform === route.platform);
    breadcrumb = `${plugin.displayName} / 依赖位置 / ${target?.displayName ?? route.dependencyPluginId}`;
    context = platformLabel(route.platform);
    title = `设置 ${target?.displayName ?? route.dependencyPluginId} 的位置`;
    description = target?.explanation ?? '依赖位置已变化。请返回重新检查。';
    actions = (['project', 'user'] as const).map((candidateScope): ActionItem => {
      const unavailable = !target?.allowedScopes.includes(candidateScope)
        || target.minimumScope === 'user' && candidateScope === 'project';
      return {
        label: scopeLabel(candidateScope),
        selected: target?.scope === candidateScope,
        description: candidateScope === 'user'
          ? '更宽：对其他项目可见，并会改变你的用户环境'
          : '仅供当前项目使用；适合项目共享 intent',
        disabled: unavailable ? '这个依赖或上游约束不允许此位置' : undefined,
        run: async () => {
          await props.controller.setDependencyScope(
            route.dependencyPluginId,
            route.platform,
            candidateScope,
          );
          back();
        },
      };
    });
    content = <Box flexDirection="column">
      {target?.assignmentSource === 'consumerPromotion'
        ? <Callout status="warning" title="fixed-point 位置提升" description={`上游依赖需要至少使用${scopeLabel(target.minimumScope)}。`} />
        : null}
      <SemanticRows actions={actions} focus={focus} kind="choice" compact={policy.mode === 'compact'} />
    </Box>;
    help = '↑↓ 移动 · Enter 选择 · Esc 返回';
  } else if (route.name === 'pluginDetail' && plugin) {
    breadcrumb = `我的插件 / ${plugin.displayName}`;
    context = `${plugin.sourceLabel}${plugin.version ? ` · ${plugin.version}` : ''}`;
    title = plugin.displayName;
    description = plugin.description;
    const dependencySummary = plugin.dependencySummary;
    const detailMenu = dynamicMenu!;
    actions = detailMenu.map((action): ActionItem => {
      if (action.id === 'resolveScopeConflict') return {
        label: `保留${scopeLabel(action.keepScope)}，移除${scopeLabel(action.scope)} root…`,
        description: action.description,
        status: 'error',
        run: () => beginScopeConflictRecovery(action),
      };
      if (action.id === 'platform' || action.id === 'scopeConflict') {
        const placement = plugin.installedPlacements.find((entry) => entry.platform === action.platform)!;
        const projected = placementStatus(placement);
        return {
          label: platformLabel(action.platform),
          description: projected.description,
          meta: projected.value,
          status: projected.status,
          run: () => action.id === 'scopeConflict'
            ? go({ name: 'issueDetail', issueId: `scope:${plugin.pluginId}:${action.platform}` })
            : go({ name: 'platform', pluginId: plugin.pluginId, platform: action.platform }),
        };
      }
      if (action.id === 'dependencies') return {
        label: '必需依赖',
        description: dependencySummary!.issueCount > 0 ? `${dependencySummary!.issueCount} 项需要处理` : '查看直接、间接依赖和被使用情况',
        meta: dependencySummaryText(dependencySummary!),
        status: dependencySummary!.issueCount > 0 ? 'warning' : undefined,
        run: () => go({ name: 'pluginDependencies', pluginId: plugin.pluginId }),
      };
      if (action.id === 'portableSkills') return {
        label: '通用 Skills',
        description: '选择 Skill 和 Agent 后交给 Skills CLI 安装',
        meta: dependencySummary ? `可安装 · ${dependencySummary.totalCount} 个插件依赖` : '可安装',
        run: () => beginPortable(plugin.pluginId),
      };
      if (action.id === 'settings') return { label: '设置', description: '查看当前实际生效的配置和值来源', meta: `${plugin.configFieldCount} 项配置`, run: () => beginConfigFlow(plugin.pluginId) };
      if (action.id === 'sourceProblem') return { label: '查看来源问题', status: 'warning', run: () => go({ name: 'sourceDetail', sourceId: plugin.sourceId }) };
      return { label: '关于与技术详情', description: '版本、来源和受管内容', run: () => go({ name: 'pluginAbout', pluginId: plugin.pluginId }) };
    });
    const detailViewport = actionViewport(actions, policy.mode === 'compact', effectiveFocus, scrollOffset, pageActionBudget(4));
    content = <SectionCard title="插件操作"><SemanticRows actions={actions} focus={effectiveFocus} kind="action" compact={policy.mode === 'compact'} offset={detailViewport.offset} limit={detailViewport.limit} /></SectionCard>;
  } else if (route.name === 'platform' && plugin) {
    const placement = props.controller.getPlatformPlacement(plugin.pluginId, route.platform);
    const platformMenu = dynamicMenu!;
    const typedIssue = placement?.state === 'installed' && placement.health === 'error'
      ? props.controller.listUserIssues().find((candidate) =>
          candidate.pluginId === plugin.pluginId
          && candidate.platform === route.platform
          && candidate.scope === placement.scope)
      : undefined;
    const collisionIssue = placement?.state === 'blocked'
      || placement?.state === 'installed' && placement.blockingReason === 'artifactCollision'
      ? props.controller.listUserIssues().find((candidate) =>
          candidate.pluginId === plugin.pluginId
          && candidate.platform === route.platform
          && candidate.category === 'artifactCollision')
      : undefined;
    const sourceIssue = plugin.aggregateStatus === 'unavailable'
      ? props.controller.listUserIssues().find((candidate) =>
          candidate.entity.kind === 'source' && candidate.sourceId === plugin.sourceId)
      : undefined;
    const platformAction = (action: PluginMenuAction): ActionItem => {
      if (action.id === 'sourceProblem') return { label: '查看来源问题', description: `${plugin.sourceId} 当前不可用`, run: () => go({ name: 'issueDetail', issueId: `source:${plugin.sourceId}:unavailable` }) };
      if (action.id === 'refreshSource') return { label: '重新加载状态', description: `如需同步，先在终端运行 aw catalog source sync ${plugin.sourceId}`, run: async () => { await props.controller.reloadCatalog({ sourceId: plugin.sourceId }); } };
      if (action.id === 'add') return { label: `添加到 ${platformLabel(route.platform)}…`, description: '选择使用位置', run: () => {
        const initialScope = placement?.state === 'notInstalled'
          ? placement.supportedScopes[0] ?? scope
          : scope;
        setScope(initialScope);
        setSelectedTargets([]);
        setTargetSelections({});
        setPreferredTarget(route.platform);
        props.controller.beginInstallFlow(plugin.pluginId, initialScope);
        go({ name: 'installPlacement', pluginId: plugin.pluginId });
      } };
      if (action.id === 'addScope') return {
        label: `在${scopeLabel(action.scope)}中启用…`,
        description: '只增加该 scope 的 activation；shared native 保持复用',
        run: () => beginSecondScope(plugin, action.platform, action.scope),
      };
      if (action.id === 'about') return { label: '查看支持信息', description: 'manifest 与平台能力', run: () => go({ name: 'pluginAbout', pluginId: plugin.pluginId }) };
      if (action.id === 'source') return { label: '查看来源', run: () => go({ name: 'sourceDetail', sourceId: plugin.sourceId }) };
      if (action.id === 'outputCollision') return {
        label: '查看输出冲突',
        description: '不会覆盖或删除占用内容',
        status: 'error',
        run: () => collisionIssue
          ? go({ name: 'issueDetail', issueId: collisionIssue.issueId })
          : go({ name: 'pluginTechnical', pluginId: plugin.pluginId }),
      };
      if (action.id === 'scopeConflict') return { label: '查看位置冲突问题', run: () => go({ name: 'issueDetail', issueId: `scope:${plugin.pluginId}:${route.platform}` }) };
      if (action.id === 'resolveScopeConflict') return {
        label: `保留${scopeLabel(action.keepScope)}，移除${scopeLabel(action.scope)} root…`,
        description: action.description,
        status: 'error',
        run: () => beginScopeConflictRecovery(action),
      };
      if (action.id === 'upgrade') return { label: `升级到 ${action.availableVersion}…`, description: '使用当前来源中的版本重建', run: () => beginReview({ kind: 'pluginWrite', action: 'upgrade', pluginId: plugin.pluginId, platform: action.platform, scope: action.scope }) };
      if (action.id === 'sync') return {
        label: '同步 desired intent…',
        description: placement?.state === 'installed'
          ? placement.recovery?.find((entry) => entry.command === 'sync')?.description
            ?? '进入现有 Review、进度和结果链修复 needsSync 或 drift'
          : undefined,
        run: () => placement?.state === 'installed'
          ? beginReview({ kind: 'pluginWrite', action: 'sync', pluginId: plugin.pluginId, platform: route.platform, scope: placement.scope })
          : undefined,
      };
      if (action.id === 'reinstall') return { label: placement?.state === 'installed' && placement.health === 'incomplete' ? '重新连接缺失内容…' : '重新安装…', description: '保留现有设置并重新生成受管内容', run: () => beginReview({ kind: 'pluginWrite', action: 'reinstall', pluginId: plugin.pluginId, platform: action.platform, scope: action.scope }) };
      if (action.id === 'remove') return { label: `从${scopeLabel(action.scope)}移除…`, description: '保留插件设置', status: 'error', run: () => beginPluginRemoval(plugin, action.platform, action.scope) };
      if (action.id === 'technical') return typedIssue
        ? { label: '查看对应问题', description: typedIssue.explanation, run: () => go({ name: 'issueDetail', issueId: typedIssue.issueId }) }
        : { label: placement?.state === 'installed' && placement.health === 'error' ? '查看安全技术详情' : placement?.state === 'installed' && placement.health === 'incomplete' ? '查看影响' : '查看安装详情', description: '组件与诊断信息', run: () => go({ name: 'pluginTechnical', pluginId: plugin.pluginId }) };
      return { label: '返回插件', run: back };
    };
    breadcrumb = `${plugin.displayName} / ${platformLabel(route.platform)}`;
    const installedPlacementRows = placement?.state === 'installed' ? <>
      <StaticRow title="Desired placement" meta={placement.desiredScopes?.map(scopeLabel).join('、') || scopeLabel(placement.scope)} compact />
      <StaticRow title="Actual scope 状态" meta={placement.actualState ?? placement.health} status={placement.actualState === 'ready' ? 'success' : placement.actualState === 'conflict' ? 'error' : 'warning'} compact />
      {placement.sharedNative ? <StaticRow title="Shared native" meta={placement.sharedNative.state} status={placement.sharedNative.state === 'present' ? 'success' : 'warning'} compact /> : null}
      {placement.activation ? <StaticRow title="Activation" meta={`user ${placement.activation.user ? 'on' : 'off'} · project ${placement.activation.project ? 'on' : 'off'}`} compact /> : null}
      {placement.extensions ? <StaticRow title="AW-only extensions" meta={`${placement.extensions.state} · ${placement.extensions.kinds.join('、') || '无'}`} status={placement.extensions.state === 'ready' ? 'success' : placement.extensions.state === 'conflict' ? 'error' : 'warning'} compact /> : null}
    </> : null;
    if (plugin.aggregateStatus === 'unavailable') {
      const sourceOverview = props.controller.getSourceOverview(plugin.sourceId);
      const diagnostic = sourceIssue?.diagnostic ?? sourceDiagnostic(
        plugin.sourceId,
        sourceOverview.health?.state ?? sourceOverview.source?.state,
        sourceOverview.detail,
      );
      title = `暂时无法管理 ${platformLabel(route.platform)}`;
      description = '';
      actions = platformMenu.map(platformAction);
      content = <Box flexDirection="column">{diagnostic
        ? <DiagnosticSummary diagnostic={diagnostic} compact={policy.mode === 'compact'} />
        : null}<SemanticRows actions={actions} focus={effectiveFocus} kind="action" compact={policy.mode === 'compact'} /></Box>;
    } else if (!placement || placement.state === 'notInstalled') {
      title = `尚未添加到 ${platformLabel(route.platform)}`;
      description = '此插件支持所列使用位置。';
      actions = platformMenu.map(platformAction);
      content = <Box flexDirection="column"><StatusCard status="muted" title="未添加" description="插件设置保持不变" /><SemanticRows actions={actions} focus={effectiveFocus} kind="action" compact={policy.mode === 'compact'} /></Box>;
    } else if (placement.state === 'blocked'
      || placement.state === 'installed' && placement.blockingReason === 'artifactCollision') {
      title = `${platformLabel(route.platform)} 无法添加`;
      description = placement.state === 'installed'
        ? '受管内容仍可安全移除；输出位置同时存在冲突内容。'
        : '输出位置已有不属于当前插件的内容。';
      actions = platformMenu.map(platformAction);
      content = <Box flexDirection="column"><StatusCard status="error" title="输出冲突" description="AW 不会覆盖或删除占用内容" /><SemanticRows actions={actions} focus={effectiveFocus} kind="action" compact={policy.mode === 'compact'} /></Box>;
    } else if (placement.state === 'scopeConflict') {
      title = '安装位置冲突';
      description = '正常状态只能保留一个位置。';
      actions = platformMenu.map(platformAction);
      content = <SemanticRows actions={actions} focus={effectiveFocus} kind="action" compact={policy.mode === 'compact'} />;
    } else if (placement.health === 'error') {
      const diagnostic = typedIssue?.diagnostic ?? {
        severity: 'error' as const,
        title: '状态检查失败',
        userMessage: '平台状态检查失败，当前不能安全选择写操作。',
        impact: [
          { state: 'blocked' as const, message: '当前只提供只读操作。' },
          { state: 'preserved' as const, message: '现有安装和已保存设置不会因本页自动改变。' },
        ],
        nextStep: '查看安全技术详情，然后重新检查当前状态。',
        technical: {
          code: 'targetStateError',
          stage: 'read-platform-state',
          context: [
            { key: 'pluginId' as const, value: plugin.pluginId },
            { key: 'platform' as const, value: route.platform },
            { key: 'scope' as const, value: placement.scope },
          ],
        },
      };
      title = `${platformLabel(route.platform)} 暂时不可管理`;
      description = '';
      actions = platformMenu.map(platformAction);
      content = <Box flexDirection="column"><DiagnosticSummary diagnostic={diagnostic} compact={policy.mode === 'compact'} /><SemanticRows actions={actions} focus={effectiveFocus} kind="action" compact={policy.mode === 'compact'} /></Box>;
    } else if (placement.health === 'incomplete') {
      title = `${platformLabel(route.platform)} ${placement.health === 'incomplete' ? '安装不完整' : '暂时不可用'}`;
      description = '缺少一项必要内容，插件可能无法稳定启动。';
      actions = platformMenu.map(platformAction);
      const actualTitle = placement.actualState === 'needsSync' ? '需要同步'
        : placement.actualState === 'drifted' ? '现场已漂移'
          : placement.actualState === 'conflict' ? '位置与扩展冲突' : '需要处理';
      content = <Box flexDirection="column"><StatusCard status={placement.actualState === 'conflict' ? 'error' : 'warning'} title={actualTitle} description={`${scopeLabel(placement.scope)} · ${plugin.sourceLabel}`}>{installedPlacementRows}</StatusCard><SemanticRows actions={actions} focus={effectiveFocus} kind="action" compact={policy.mode === 'compact'} /></Box>;
    } else {
      title = `已安装到${scopeLabel(placement.scope)}`;
      const installedVersion = placement.revision.installedVersion;
      description = `当前检查正常${installedVersion ? `；已安装版本 ${installedVersion}` : ''}。`;
      actions = platformMenu.map(platformAction);
      content = <Box flexDirection="column"><StatusCard status="success" title="状态正常" description={`${scopeLabel(placement.scope)}${installedVersion ? ` · 已安装版本 ${installedVersion}` : ''}`}>{installedPlacementRows}</StatusCard><SemanticRows actions={actions} focus={effectiveFocus} kind="action" compact={policy.mode === 'compact'} /></Box>;
    }
  } else if (route.name === 'configLayer' && plugin) {
    breadcrumb = `${plugin.displayName} / 设置`;
    const selectedField = route.fieldKey && configPage
      ? configPage.groups.flatMap((group) => group.fields).find((field) => field.key === route.fieldKey)
      : undefined;
    const selectedPreset = route.presetId && configPage
      ? configPage.presets.find((preset) => preset.id === route.presetId)
      : undefined;
    title = selectedField ? `修改“${selectedField.title}”`
      : selectedPreset ? `应用“${selectedPreset.title}”` : `修改 ${plugin.displayName} 设置`;
    description = selectedField
      ? `当前：${effectiveFieldDisplay(selectedField)} · ${selectedField.effectiveSourceLabel}。选择保存位置后直接编辑。`
      : selectedPreset ? '选择保存位置后，方案会应用到该位置的草稿。' : '选择修改保存到哪里。';
    help = '↑↓ 移动 · Enter 打开 · Esc 返回';
    actions = [
      { label: '个人默认', description: '在所有项目中作为默认值', meta: configLayerCounts.user === undefined ? undefined : `${configLayerCounts.user} 个值`, run: () => openConfigLayerTarget({ scope: 'user', projectLayer: 'shared' }) },
      { label: '当前项目', description: '随仓库共享，适合团队约定', meta: configLayerCounts.project === undefined ? undefined : `${configLayerCounts.project} 个值`, run: () => openConfigLayerTarget({ scope: 'project', projectLayer: 'shared' }) },
      { label: '当前项目（仅本机）', description: '只保存在本机，不提交到仓库', meta: configLayerCounts.local === undefined ? undefined : configLayerCounts.local === 0 ? '未设置' : `${configLayerCounts.local} 个值`, run: () => openConfigLayerTarget({ scope: 'project', projectLayer: 'local' }) },
    ];
    content = <SemanticRows actions={actions} focus={focus} kind="section" compact={policy.mode === 'compact'} />;
  } else if (route.name === 'configFields' && plugin) {
    const readonly = route.layer.scope === 'effective';
    breadcrumb = readonly ? `${plugin.displayName} / 设置` : `${plugin.displayName} / 设置 / ${configLayerLabel(route.layer)}`;
    title = readonly ? '当前插件设置' : '编辑插件设置';
    description = readonly
      ? '查看当前实际生效的值；← → 切换设置分组。'
      : `保存位置：${configLayerLabel(route.layer)} · ← → 切换设置分组。`;
    if (!readonly && configActionError) description = configActionError;
    help = readonly
      ? '↑↓ 选择配置 · Enter 修改 · ←→ 分组 · Esc 返回'
      : '↑↓ 移动 · Enter 修改 · ←→ 分组 · s 保存 · u 恢复继承 · Esc 返回';
    if (!currentConfigPage) {
      content = <StatusCard status="info" title="正在读取可信设置定义"><ProgressRow title="读取 manifest 设置字段" state="active" /></StatusCard>;
    } else {
      visibleConfigTabs = configTabs(currentConfigPage);
      const requestedTab = snapshot.router.current.context.configGroupId;
      const activeTab = visibleConfigTabs.find((tab) => tab.id === requestedTab) ?? visibleConfigTabs[0];
      activeConfigTabId = activeTab?.id;
      const activeGroup = activeTab?.kind === 'group'
        ? currentConfigPage.groups.find((group) => group.id === activeTab.id)
        : undefined;
      const mutableLayer = {
        scope: route.layer.scope as Scope,
        projectLayer: route.layer.projectLayer,
      };
      const tabActions: ActionItem[] = activeTab?.kind === 'presets'
        ? currentConfigPage.presets.map((preset) => ({
            label: preset.title,
            description: (preset.privateFieldTitles?.length ?? 0) > 0
              ? `${preset.description ? `${preset.description} · ` : ''}${preset.privateFieldTitles!.join('、')}需手动输入`
              : preset.description,
            run: readonly
              ? () => go({
                  name: 'configLayer',
                  pluginId: plugin.pluginId,
                  presetId: preset.id,
                })
              : () => applyConfigPreset(currentConfigPage, preset.id),
          }))
        : (activeGroup?.fields ?? []).map((field) => ({
            label: field.title,
            description: readonly
              ? field.sourceLabel === '未设置' ? '没有任何位置提供值' : `来自${field.sourceLabel}`
              : `${field.description ? `${field.description} · ` : ''}当前有效：${effectiveFieldDisplay(field)} · ${field.effectiveSourceLabel}`,
            meta: readonly ? effectiveFieldDisplay(field) : currentFieldDisplay(field),
            configKey: field.key,
            run: readonly
              ? () => go({
                  name: 'configLayer',
                  pluginId: plugin.pluginId,
                  fieldKey: field.key,
                  groupId: activeGroup!.id,
                })
              : () => go(field.configured ? {
                  name: 'configFieldAction',
                  pluginId: plugin.pluginId,
                  layer: mutableLayer,
                  fieldKey: field.key,
                } : {
                  name: 'configFieldEditor',
                  pluginId: plugin.pluginId,
                  layer: mutableLayer,
                  fieldKey: field.key,
                  editor: fieldEditor(field),
                }),
          }));
      const operationActions: ActionItem[] = readonly ? [] : [
        { label: '保存修改', description: dirty ? '查看安全变更汇总' : '当前没有未保存修改', disabled: dirty ? undefined : '当前没有未保存修改', run: beginConfigSave },
        ...(currentConfigPage.storedCount > 0 ? [{
          label: route.layer.scope === 'user'
            ? '清空个人默认…'
            : route.layer.projectLayer === 'local' ? '删除本机设置…' : '清空当前项目共享设置…',
          description: `删除${configLayerLabel(route.layer)}中的全部值并恢复继承；其他设置层保持不变`,
          status: 'error' as const,
          run: () => beginReview({
            kind: 'configReset',
            pluginId: plugin.pluginId,
            scope: route.layer.scope as Scope,
            projectLayer: route.layer.projectLayer,
            changes: currentConfigPage.groups.flatMap((group) => group.fields)
              .filter((field) => field.configured)
              .map((field) => ({
                key: field.key,
                title: field.title,
                before: field.displayValue,
                after: `恢复继承（${field.fallbackDisplayValue ?? '未设置'} · ${field.fallbackSourceLabel ?? '未设置'}）`,
              })),
          }),
        }] : []),
      ];
      actions = [...tabActions, ...operationActions];
      const effectiveConfigFocus = Math.min(focus, Math.max(0, actions.length - 1));
      const fieldFocus = tabActions.length > 0
        ? effectiveConfigFocus < tabActions.length ? effectiveConfigFocus : Math.min(scrollOffset, tabActions.length - 1)
        : 0;
      const operationRows = operationActions.reduce((rows, action) =>
        rows + (policy.mode === 'compact' || !action.description ? 1 : 2), 0);
      const viewport = actionViewport(tabActions, policy.mode === 'compact', fieldFocus, scrollOffset,
        pageActionBudget(1 + operationRows + 3));
      const totalFields = currentConfigPage.groups.reduce((count, group) => count + group.fields.length, 0);
      const countLabel = `${totalFields} 项${currentConfigPage.presets.length > 0 ? ` · ${currentConfigPage.presets.length} 个方案` : ''}`;
      context = readonly ? countLabel
        : dirty ? `${Object.keys(draftUpdates).length + draftRemoves.length} 项未保存` : countLabel;
      content = <Box flexDirection="column">
        {activeTab ? <ConfigGroupTabs
          tabs={visibleConfigTabs}
          current={activeTab.id}
          compact={policy.mode === 'compact'}
          columns={size.columns - 2}
        /> : null}
        {activeTab && tabActions.length > 0
          ? <SectionCard title={activeTab.label} meta={viewport.hiddenBefore > 0 || viewport.hiddenAfter > 0 ? `${viewport.position}/${viewport.total}` : undefined}>
              <SemanticRows
                actions={tabActions}
                focus={effectiveConfigFocus}
                kind="section"
                compact={policy.mode === 'compact'}
                offset={viewport.offset}
                limit={viewport.limit}
              />
            </SectionCard>
          : null}
        {operationActions.length > 0
          ? <SemanticRows
              actions={actions}
              focus={effectiveConfigFocus}
              kind="action"
              compact={policy.mode === 'compact'}
              offset={tabActions.length}
              limit={operationActions.length}
            />
          : null}
      </Box>;
    }
  } else if (route.name === 'configFieldAction' && plugin && activeField) {
    const layer = configLayerLabel(route.layer);
    breadcrumb = `${plugin.displayName} / 设置 / ${layer} / ${activeField.title}`;
    title = activeField.title;
    description = `这个字段在${layer}中已经有值。`;
    help = '↑↓ 移动 · Enter 选择 · Esc 返回';
    const deleteLabel = route.layer.scope === 'user'
      ? '删除个人默认中的值'
      : route.layer.projectLayer === 'local' ? '删除本机设置中的值' : '删除当前项目中的值';
    actions = [
      {
        label: '修改值…',
        run: () => go({
          name: 'configFieldEditor',
          pluginId: plugin.pluginId,
          layer: route.layer,
          fieldKey: activeField.key,
          editor: fieldEditor(activeField),
        }),
      },
      draftRemoves.includes(activeField.key)
        ? { label: '撤销删除', run: () => { cancelDraftRemoval(activeField.key); back(); } }
        : { label: deleteLabel, status: 'error', run: () => { removeDraft(activeField.key); back(); } },
    ];
    content = <Box flexDirection="column"><SectionCard>
      <StaticRow title={`${layer}中的值`} meta={currentFieldDisplay(activeField)} />
      <StaticRow title="当前实际生效" meta={`${effectiveFieldDisplay(activeField)} · 来自${activeField.effectiveSourceLabel}`} />
      <StaticRow title="删除后将恢复" meta={`${activeField.fallbackDisplayValue ?? '未设置'} · 来自${activeField.fallbackSourceLabel ?? '未设置'}`} />
    </SectionCard><SemanticRows actions={actions} focus={focus} kind="action" compact={policy.mode === 'compact'} /></Box>;
  } else if (route.name === 'configFieldEditor' && plugin && activeField) {
    breadcrumb = `${plugin.displayName} / 设置 / ${activeField.title}`;
    help = route.editor === 'enum' || route.editor === 'boolean'
      ? '↑↓ 移动 · Enter 使用 · Esc 取消'
      : '输入 · Enter 继续 · Ctrl-U 删除本层值 · Esc 取消';
    if (route.editor === 'enum') {
      title = `选择${activeField.title}`;
      description = '保存值仍是 manifest 中的原始 enum token。';
      actions = (activeField.enumValues ?? []).map((value) => ({
        label: `${activeField.valueLabels?.[value] ?? value}${activeField.recommendedValue === value ? '（推荐）' : ''}`,
        selected: draftUpdates[activeField.key] === value || (!Object.hasOwn(draftUpdates, activeField.key) && activeField.value === value),
        run: () => { updateDraft(activeField.key, value); back(); },
      }));
      content = <SemanticRows actions={actions} focus={focus} kind="choice" compact={policy.mode === 'compact'} />;
    } else if (route.editor === 'boolean') {
      title = `${activeField.title}？`;
      description = activeField.description ?? '选择开启或关闭。';
      actions = [{ label: '开启', selected: draftUpdates[activeField.key] === true || (!Object.hasOwn(draftUpdates, activeField.key) && activeField.value === true), run: () => { updateDraft(activeField.key, true); back(); } }, { label: '关闭', selected: draftUpdates[activeField.key] === false || (!Object.hasOwn(draftUpdates, activeField.key) && activeField.value === false), run: () => { updateDraft(activeField.key, false); back(); } }];
      content = <SemanticRows actions={actions} focus={focus} kind="choice" compact={policy.mode === 'compact'} />;
    } else {
      title = route.editor === 'number' ? `输入${activeField.title}` : route.editor === 'sensitive' ? '输入敏感值' : `输入${activeField.title}`;
      description = route.editor === 'number'
        ? `允许范围：${activeField.min ?? '不限'}–${activeField.max ?? '不限'}${activeField.unit ? ` ${activeField.unit}` : ''}。`
        : route.editor === 'sensitive' ? '当前值不会回显；留空不会自动删除旧值。' : activeField.description ?? '';
      content = <InputCard focused title={<InputDisplay value={inputValue} sensitive={route.editor === 'sensitive'} placeholder={activeField.placeholder} columns={Math.max(8, size.columns - 8)} />} description={inputError ?? (route.editor === 'sensitive' ? '输入已隐藏。' : activeField.placeholder ?? '按 Enter 使用输入值。')} status={inputError ? 'error' : undefined} />;
    }
  } else if (route.name === 'configUnavailable' && plugin) {
    breadcrumb = `${plugin.displayName} / 设置`;
    context = '暂时不可编辑';
    const diagnostic = configUnavailableDiagnostic(route);
    title = diagnostic.title;
    description = '';
    actions = [
      { label: `在终端运行 aw catalog source sync ${plugin.sourceId}`, description: '同步成功后重新加载 TUI', run: back },
      { label: showTechnical ? '返回问题摘要' : '技术详情', description: '查看脱敏错误代码和阶段', run: () => setShowTechnical((value) => !value) },
      { label: '返回', run: back },
    ];
    content = <Box flexDirection="column"><DiagnosticSummary diagnostic={diagnostic} technical={showTechnical} compact={policy.mode === 'compact'} /><SemanticRows actions={actions} focus={focus} kind="action" compact={policy.mode === 'compact'} /></Box>;
  } else if (route.name === 'sourceList') {
    breadcrumb = '插件来源';
    title = '插件来源';
    description = '单个来源失败不会阻止其他来源继续工作。';
    context = `${props.controller.listSources().length} 个来源`;
    help = '↑↓ 移动 · Enter 打开 · Esc 返回';
    actions = [
      ...props.controller.listSources().map((source) => {
        const overview = props.controller.getSourceOverview(source.id);
        const generation = props.controller.getCatalogGeneration(source.id);
        const health = overview.health?.state ?? source.state;
        const status = generation?.active ? `Active ${generation.active.catalogVersion}`
          : health === 'ready' ? '当前使用'
          : '无法读取';
        return {
          label: `${source.id}${source.primary ? '  主来源' : ''}`,
          description: `${overview.detail?.type === 'path' ? '本地目录' : 'Git 仓库'} · ${source.count ?? 0} 个插件`,
          meta: status,
          status: !generation?.active || health === 'unavailable' ? 'error' as const
            : source.primary ? 'success' as const : undefined,
          run: () => go({ name: 'sourceDetail', sourceId: source.id }),
        };
      }),
      { label: '＋ 添加来源', description: 'Git 仓库或本地目录', run: beginAddSource },
    ];
    const viewport = actionViewport(actions, policy.mode === 'compact', focus, scrollOffset, responsiveBudget(8, 12));
    const sourceCount = Math.max(0, actions.length - 1);
    content = <Box flexDirection="column"><SemanticRows actions={actions} focus={focus} kind={focus < sourceCount ? 'section' : 'action'} compact={policy.mode === 'compact'} offset={viewport.offset} limit={viewport.limit} /></Box>;
  } else if (route.name === 'sourceDetail') {
    const overview = props.controller.getSourceOverview(route.sourceId);
    const detail = overview.detail;
    const generation = props.controller.getCatalogGeneration(route.sourceId);
    const activeVersion = generation?.active?.catalogVersion;
    const metadataInvalid = generation?.errorCode === 'catalogGenerationMetadataInvalid';
    const damagedEntry = generation?.recoveryEntryPath;
    breadcrumb = `插件来源 / ${route.sourceId}`;
    context = detail?.type === 'path' ? '本地目录' : 'Git';
    title = route.sourceId;
    description = activeVersion ? `当前使用 Active Catalog ${activeVersion}。`
      : metadataInvalid && damagedEntry
        ? `Active Catalog 条目已损坏。先安全删除 AW_HOME 下的精确条目 ${damagedEntry}，再运行 ${generation.syncInstruction}，然后重新加载 TUI。`
        : `来源没有可用 Active。请在终端运行 ${generation?.syncInstruction ?? `aw catalog source sync ${route.sourceId}`}，然后重新加载 TUI。`;
    help = '↑↓ 移动 · Enter 选择 · Esc 返回';
    actions = [
      { label: metadataInvalid ? '修复后重新加载 TUI' : '重新加载 TUI', description: metadataInvalid && damagedEntry
        ? `先删除精确条目 ${damagedEntry}，再运行 ${generation.syncInstruction}`
        : `先在终端运行 aw catalog source sync ${route.sourceId}，再重新加载 Active`, run: () => props.controller.reloadCatalog({ sourceId: route.sourceId }) },
      ...(!metadataInvalid ? [{ label: '编辑来源…', description: '只修改来源配置；不会访问网络', run: () => go({ name: 'sourceEdit' as const, sourceId: route.sourceId }) }] : []),
      { label: '设为主来源…', description: '只改变默认 marketplace', disabled: detail?.primary ? '当前已经是主来源' : undefined, run: () => beginReview({ kind: 'sourceMutation', action: 'setPrimary', sourceId: route.sourceId, changes: [{ title: '主来源', before: snapshot.viewModel?.sourceTabs.find((source) => source.primary)?.id, after: route.sourceId }] }) },
      { label: '移除来源…', description: '移除来源配置', status: 'error', disabled: detail?.primary ? '主来源不能直接移除' : undefined, run: () => beginReview({ kind: 'sourceMutation', action: 'remove', sourceId: route.sourceId, changes: [{ title: `移除来源 ${route.sourceId}` }] }) },
      { label: '技术详情', description: '查看脱敏错误代码和 Active 证据', run: () => go({ name: 'sourceTechnical', sourceId: route.sourceId }) },
    ];
    const sourceActionViewport = actionViewport(actions, policy.mode === 'compact', focus, scrollOffset, responsiveBudget(2, 5));
    content = <Box flexDirection="column"><SectionCard title="Active Catalog" status={activeVersion ? 'success' : 'warning'} compact={policy.mode === 'compact'}><StaticRow title={activeVersion ? `Catalog ${activeVersion}` : '未同步'} meta={activeVersion ? generation?.active?.digestShort : generation?.syncInstruction} compact /></SectionCard><SectionCard title="来源配置" compact={policy.mode === 'compact'}><StaticRow title="位置" meta={detail?.locationSummary ?? '不可用'} compact /><StaticRow title="引用" meta={generation?.active?.requestedRef ?? detail?.explicitRef ?? detail?.requestedRef ?? '本地目录'} compact /></SectionCard><SemanticRows actions={actions} focus={focus} kind="action" compact={policy.mode === 'compact'} offset={sourceActionViewport.offset} limit={sourceActionViewport.limit} /></Box>;
  } else if (route.name === 'sourceTechnical') {
    const overview = props.controller.getSourceOverview(route.sourceId);
    const detail = overview.detail;
    const state = overview.health?.state ?? overview.source?.state;
    const diagnostic = sourceDiagnostic(route.sourceId, state, detail, props.controller.getCatalogGeneration(route.sourceId)) ?? {
      severity: 'warning' as const,
      title: '来源解析详情',
      userMessage: '来源当前可用。',
      impact: [{ state: 'preserved' as const, message: '当前来源状态没有阻止操作。' }],
      nextStep: '返回来源详情。',
      technical: {
        code: 'catalogSourceReady',
        stage: 'resolve-source',
        sourceId: route.sourceId,
        ...(detail?.requestedRef ? { requestedRef: detail.requestedRef } : {}),
        ...(detail?.resolvedCommit ? { resolvedCommit: detail.resolvedCommit } : {}),
      },
    };
    breadcrumb = `插件来源 / ${route.sourceId} / 技术详情`;
    context = '只读';
    title = '来源技术诊断';
    description = '';
    help = 'Enter 返回 · Esc 返回';
    actions = [{ label: '返回来源详情', run: back }];
    content = <Box flexDirection="column"><DiagnosticSummary diagnostic={diagnostic} technical compact={policy.mode === 'compact'} /><SemanticRows actions={actions} focus={focus} kind="action" compact={policy.mode === 'compact'} /></Box>;
  } else if (route.name === 'sourceAdd' && sourceDraft?.owner === route.owner) {
    breadcrumb = sourceDraft.mode === 'add' ? '插件来源 / 添加' : `插件来源 / ${sourceDraft.sourceId} / 编辑`;
    const stepLabel = { type: '第 1 步，共 6 步', id: '第 2 步，共 6 步', location: '第 3 步，共 6 步', refPolicy: '第 4 步，共 6 步', ref: '第 5 步，共 6 步', subdir: '可选高级步骤' }[route.step];
    context = stepLabel;
    help = route.step === 'type' || route.step === 'refPolicy' ? '↑↓ 移动 · Enter 继续 · Esc 返回' : '输入 · Enter 继续 · Esc 返回';
    if (route.step === 'type') {
      title = '选择来源类型'; description = '来源类型创建后不能修改。';
      actions = [
        { label: 'Git 仓库', description: '从远端 Git 仓库读取 Catalog', run: () => { setSourceDraft({ ...sourceDraft, type: 'git' }); go({ name: 'sourceAdd', step: sourceDraft.sourceId ? 'location' : 'id', owner: route.owner }); } },
        { label: '本地目录', description: '用于本地开发与测试', run: () => { setSourceDraft({ ...sourceDraft, type: 'path' }); go({ name: 'sourceAdd', step: sourceDraft.sourceId ? 'location' : 'id', owner: route.owner }); } },
      ]; content = <SemanticRows actions={actions} focus={focus} kind="choice" compact={policy.mode === 'compact'} />;
    } else if (route.step === 'refPolicy') {
      title = '选择版本来源'; description = 'Release 和 Beta 是固定 Git ref 的显示预设。';
      const useRefPreset = async (refPolicy: SourceDraft['refPolicy'], ref: string): Promise<void> => {
        const next = { ...sourceDraft, refPolicy, ref };
        setSourceDraft(next);
        if (next.mode === 'update') await beginSourceUpdateReview(next);
        else go({ name: 'sourceAdd', step: 'subdir', owner: route.owner });
      };
      actions = [
        { label: '跟随 AW CLI', description: `当前 CLI ${snapshot.cliChannel === 'beta' ? 'beta' : 'release'} → catalog/${snapshot.cliChannel === 'beta' ? 'beta' : 'latest'}`, selected: sourceDraft.refPolicy === 'cliChannel', run: () => { const policy = catalogRefPolicyForPreset('followCli')!; return useRefPreset(policy.type, ''); } },
        { label: 'Release', description: '固定读取 catalog/latest', selected: sourceDraft.refPolicy === 'explicit' && sourceDraft.ref === CATALOG_LATEST_REF, run: () => { const policy = catalogRefPolicyForPreset('release')!; return useRefPreset(policy.type, policy.type === 'explicit' ? policy.ref : ''); } },
        { label: 'Beta', description: '固定读取 catalog/beta', selected: sourceDraft.refPolicy === 'explicit' && sourceDraft.ref === CATALOG_BETA_REF, run: () => { const policy = catalogRefPolicyForPreset('beta')!; return useRefPreset(policy.type, policy.type === 'explicit' ? policy.ref : ''); } },
        { label: '指定 Git ref…', description: 'branch、tag、完整 ref 或 commit', selected: sourceDraft.refPolicy === 'explicit' && sourceDraft.ref !== CATALOG_LATEST_REF && sourceDraft.ref !== CATALOG_BETA_REF, run: () => { setSourceDraft({ ...sourceDraft, refPolicy: 'explicit' }); go({ name: 'sourceAdd', step: 'ref', owner: route.owner }); } },
      ]; content = <Box flexDirection="column">
        <Text color={tuiTheme.colors.muted}>跟随含义：当前 CLI {snapshot.cliChannel === 'beta' ? 'beta → catalog/beta' : 'release → catalog/latest'}</Text>
        <SemanticRows actions={actions} focus={focus} kind="choice" compact={policy.mode === 'compact'} />
      </Box>;
    } else {
      title = route.step === 'id' ? '输入来源 ID' : route.step === 'location' ? `输入 ${sourceDraft.type === 'git' ? 'Git URL' : '绝对路径'}` : route.step === 'ref' ? '输入固定 Git 引用' : '输入 Catalog 子目录';
      description = route.step === 'subdir' ? '仓库根目录是 Catalog 时保持为空。' : '输入会在继续前按来源规范验证。';
      const displayedInput = route.step === 'location' && sourceDraft.type === 'git' && sourceInput
        ? projectCatalogSourceLocation(sourceInput)
        : route.step === 'location' && sourceDraft.type === 'path'
          ? privatePathInput(sourceInput)
          : sourceInput;
      content = <InputCard focused title={<InputDisplay value={displayedInput} columns={Math.max(8, size.columns - 8)} />} description={sourceInputError ?? (route.step === 'location' && sourceDraft.type === 'path' ? '已隐藏父目录；Backspace 仍会编辑原始输入。' : '按 Enter 继续。')} status={sourceInputError ? 'error' : undefined} />;
    }
  } else if (route.name === 'sourceEdit') {
    const detail = props.controller.getSourceOverview(route.sourceId).detail;
    breadcrumb = `插件来源 / ${route.sourceId} / 编辑`;
    title = '选择要修改的内容'; description = '来源 ID 和类型只读。';
    const startEdit = (field: SourceDraft['editField']): void => {
      if (!detail) return;
      const owner = `source-update:${route.sourceId}:${field}:${Date.now()}`;
      setSourceDraft({ owner, mode: 'update', sourceId: route.sourceId, type: detail.type, location: '', refPolicy: detail.refPolicy ?? 'cliChannel', ref: detail.explicitRef ?? '', subdir: detail.subdir ?? '', editField: field });
      setDirty(true);
      go({ name: 'sourceAdd', step: field === 'location' ? 'location' : field === 'subdir' ? 'subdir' : 'refPolicy', owner });
    };
    const switchOfficialTransport = (location: string): void => {
      if (!detail || detail.type !== 'git'
        || detail.locationSummary === projectCatalogSourceLocation(location)) return;
      const owner = `source-update:${route.sourceId}:location:${Date.now()}`;
      const next: SourceDraft = {
        owner,
        mode: 'update',
        sourceId: route.sourceId,
        type: 'git',
        location,
        refPolicy: detail.refPolicy ?? 'cliChannel',
        ref: detail.explicitRef ?? '',
        subdir: detail.subdir ?? '',
        editField: 'location',
      };
      setSourceDraft(next);
      setDirty(true);
      void beginSourceUpdateReview(next);
    };
    actions = detail?.type === 'git' ? [
      ...(route.sourceId === 'official' ? [
        { label: 'HTTPS', description: '使用系统 Git credential helper', selected: detail.locationSummary === projectCatalogSourceLocation(OFFICIAL_CATALOG_SOURCE_URL), run: () => switchOfficialTransport(OFFICIAL_CATALOG_SOURCE_URL) },
        { label: 'SSH', description: '使用本机 SSH key；Git 连接使用 BatchMode', selected: detail.locationSummary === projectCatalogSourceLocation(OFFICIAL_CATALOG_SOURCE_SSH_URL), run: () => switchOfficialTransport(OFFICIAL_CATALOG_SOURCE_SSH_URL) },
      ] : [{ label: 'Git URL', description: detail.locationSummary, run: () => startEdit('location') }]),
      { label: '版本引用', description: detail.refPolicy === 'explicit' ? `固定：${detail.explicitRef}` : '跟随 AW 版本通道', run: () => startEdit('refPolicy') },
      { label: 'Catalog 子目录', description: detail.subdir ?? '未设置', run: () => startEdit('subdir') },
    ] : [{ label: '本地目录', description: '已选择本地目录', run: () => startEdit('location') }];
    content = <Box flexDirection="column"><SemanticRows actions={actions} focus={focus} kind="section" compact={policy.mode === 'compact'} />
      {route.sourceId === 'official' && detail?.type === 'git' ? <SectionCard title="来源身份">
        <StaticRow title="逻辑 Catalog" meta="lesliechan721-arch/agent-workflow" />
        <StaticRow title="source identity" meta="HTTPS / SSH 保持一致" />
        <StaticRow title="明文 HTTP" meta="不支持" status="warning" />
      </SectionCard> : null}
    </Box>;
  } else if (route.name === 'sourceRemoveBlocked') {
    breadcrumb = `插件来源 / ${route.sourceId} / 移除`;
    context = '已阻止'; title = `无法移除 ${route.sourceId}`;
    description = sourceReferenceSummary?.inventoryComplete === false ? '引用清单不完整，不能把未知引用当作零。' : '仍有内容依赖这个来源。';
    actions = [{ label: sourceDependenciesExpanded ? '收起依赖内容' : '查看依赖内容', description: '只显示插件、来源、平台、位置和类别聚合', run: () => setSourceDependenciesExpanded((value) => !value) }, { label: '返回来源详情', run: back }];
    const countLabel = (value: number | undefined, unit: string): string => value === undefined ? '未知' : `${value} ${unit}`;
    content = <Box flexDirection="column"><Callout status="error" title={sourceReferenceSummary?.inventoryComplete === false ? '引用清单不完整' : '发现活动引用'} /><SectionCard title="引用汇总"><StaticRow title="安装位置" meta={countLabel(sourceReferenceSummary?.installationCount, '个')} /><StaticRow title="插件设置" meta={countLabel(sourceReferenceSummary?.configCount, '份')} /><StaticRow title="生命周期状态" meta={countLabel(sourceReferenceSummary?.lifecycleCount, '个')} /><StaticRow title="Marketplace" meta={countLabel(sourceReferenceSummary?.marketplaceCount, '个')} />{sourceDependenciesExpanded ? sourceReferenceSummary?.dependencies.slice(0, Math.max(1, pageActionBudget(10))).map((dependency, index) => <StaticRow key={`${dependency.category}:${dependency.pluginId ?? dependency.sourceId ?? index}`} title={`${dependency.category} · ${dependency.pluginId ?? dependency.sourceId ?? '身份未知'}`} meta={`${dependency.platform ? platformLabel(dependency.platform) : ''}${dependency.scope ? ` · ${scopeLabel(dependency.scope)}` : ''}`} />) : null}</SectionCard><SemanticRows actions={actions} focus={focus} kind="action" compact={policy.mode === 'compact'} /></Box>;
  } else if (route.name === 'issueList') {
    const issues = props.controller.listUserIssues();
    breadcrumb = '需要处理';
    context = issues.length > 0 ? `${issues.length} 项` : '没有问题';
    title = issues.length > 0 ? '需要处理' : '当前没有需要处理的问题';
    description = issues.length > 0
      ? '选择一个问题，查看影响和真实可用的处理路径。'
      : '当前状态检查没有发现需要处理的安装、来源或设置问题。';
    if (issues.length === 0) {
      actions = [
        { label: '返回首页', run: () => go({ name: 'home' }) },
        { label: '浏览插件', run: () => go({ name: 'pluginList', mode: 'browse' }) },
      ];
    } else {
      actions = issues.map((entry) => ({
        label: entry.category.startsWith('dependency')
          ? `${props.controller.getPluginOverview(entry.pluginId ?? '')?.displayName ?? entry.pluginId ?? entry.title}${entry.platform ? ` · ${platformLabel(entry.platform)}` : ''}`
          : entry.title,
        description: entry.category.startsWith('dependency')
          ? `${props.controller.getPluginOverview(entry.dependencyPluginId ?? '')?.displayName ?? entry.dependencyPluginId ?? entry.explanation} · ${entry.impact[0] ?? ''}`
          : `${entry.explanation} · ${entry.impact[0] ?? ''}`,
        status: 'error' as const,
        run: () => entry.category === 'dependencyStillRequired' && entry.pluginId
          ? go({ name: 'pluginDependencies', pluginId: entry.pluginId, view: 'removeBlocked',
              ...(entry.platform ? { platform: entry.platform } : {}),
              ...(entry.scope ? { scope: entry.scope } : {}) })
          : go({ name: 'issueDetail', issueId: entry.issueId }),
      }));
    }
    const viewport = actionViewport(actions, policy.mode === 'compact', focus, scrollOffset, responsiveBudget(8, 12));
    if (issues.length === 0) {
      content = <SemanticRows actions={actions} focus={focus} kind="action" compact={policy.mode === 'compact'} offset={viewport.offset} limit={viewport.limit} />;
    } else {
      const groupCounts = new Map<UserIssueViewModel['group'], number>();
      for (const issueEntry of issues) {
        groupCounts.set(issueEntry.group, (groupCounts.get(issueEntry.group) ?? 0) + 1);
      }
      const visibleGroups: Array<{
        group: UserIssueViewModel['group'];
        startIndex: number;
        actions: ActionItem[];
      }> = [];
      const visibleEnd = Math.min(actions.length, viewport.offset + viewport.limit);
      for (let index = viewport.offset; index < visibleEnd; index += 1) {
        const group = issues[index]!.group;
        const currentGroup = visibleGroups.at(-1);
        if (!currentGroup || currentGroup.group !== group) {
          visibleGroups.push({ group, startIndex: index, actions: [actions[index]!] });
        } else currentGroup.actions.push(actions[index]!);
      }
      content = <Box flexDirection="column">{visibleGroups.map((group) => <SectionCard
        key={`${group.group}:${group.startIndex}`}
        title={issueGroupLabel(group.group)}
        meta={`${groupCounts.get(group.group) ?? group.actions.length} 项`}
        compact={policy.mode === 'compact'}
      >
        <SemanticRows
          actions={group.actions}
          focus={focus - group.startIndex}
          kind="task"
          compact={policy.mode === 'compact'}
        />
      </SectionCard>)}</Box>;
    }
  } else if (route.name === 'issueDetail' && issue) {
    breadcrumb = `需要处理 / ${issue.pluginId ?? issue.sourceId ?? issue.entity.id}`;
    context = issue.platform ? `${platformLabel(issue.platform)}${issue.scope ? ` · ${scopeLabel(issue.scope)}` : ''}` : issue.sourceId;
    title = issue.title;
    description = issue.explanation;
    const runIssueAction = async (entry: UserIssueActionViewModel): Promise<void> => {
      const intent = issueWriteIntent(issue, entry);
      if (intent) {
        await beginReview(intent);
        return;
      }
      if (entry.id === 'refreshSource' && issue.sourceId) await props.controller.reloadCatalog({ sourceId: issue.sourceId });
      else if (entry.id === 'retryLater') go({ name: 'issueList' });
      else if (entry.id === 'editSource' && issue.sourceId) go(issue.entity.kind === 'source'
        ? { name: 'sourceEdit', sourceId: issue.sourceId }
        : { name: 'sourceDetail', sourceId: issue.sourceId });
      else if (entry.id === 'reAddSource' && issue.sourceId) beginIssueSourceAdd(issue.sourceId);
      else if (entry.id === 'viewSourceChange' && issue.sourceId) go({ name: 'sourceTechnical', sourceId: issue.sourceId });
      else if (entry.id === 'openConfig' && issue.pluginId) {
        go(issue.configLayer
          ? { name: 'configFields', pluginId: issue.pluginId, layer: issue.configLayer }
          : { name: 'configLayer', pluginId: issue.pluginId });
      }
      else if (entry.id === 'viewDependencies' && issue.pluginId) {
        go({ name: 'pluginDependencies', pluginId: issue.pluginId });
      }
      else if (entry.id === 'viewDependencyIssue' && entry.pluginId) {
        const dependencyIssue = props.controller.listUserIssues().find((candidate) =>
          candidate.pluginId === entry.pluginId
          && candidate.issueId !== issue.issueId);
        if (dependencyIssue) go({ name: 'issueDetail', issueId: dependencyIssue.issueId });
        else go({ name: 'pluginDependencies', pluginId: entry.pluginId });
      }
      else setShowTechnical((value) => !value);
    };
    const issueHasTechnicalDetails = Boolean(issue.diagnostic.technical);
    actions = issue.actions.filter((entry) => entry.id !== 'viewTechnical' || issueHasTechnicalDetails).map((entry) => ({
      label: entry.id === 'viewTechnical' && showTechnical ? '返回问题摘要' : entry.label,
      description: entry.description,
      status: entry.id === 'remove'
        || entry.id === 'keepUserScope' || entry.id === 'keepProjectScope' ? 'error' as const : undefined,
      run: () => runIssueAction(entry),
    }));
    const issuePlugin = issue.pluginId ? props.controller.getPluginOverview(issue.pluginId) : undefined;
    const issueOverview = issue.pluginId ? props.controller.getPluginDependencyOverview(issue.pluginId) : undefined;
    const issueDiagnosticSummary = <DiagnosticSummary
      diagnostic={issue.diagnostic}
      technical={showTechnical}
      compact={policy.mode === 'compact' || issue.category.startsWith('dependency')
        || issue.category === 'scopeConflict'}
    />;
    const issueActionViewport = actionViewport(actions, policy.mode === 'compact', focus, scrollOffset, pageActionBudget(6));
    const compactTechnicalActionViewport = policy.mode === 'compact' && showTechnical
      ? {
          offset: Math.min(Math.max(0, focus - 1), Math.max(0, actions.length - 2)),
          limit: 2,
        }
      : {};
    if (issue.category === 'dependencyStillRequired' && issuePlugin) {
      const blockingDependents = issue.platform && issue.scope
        ? props.controller.getBlockingDependents(issuePlugin.pluginId, issue.platform, issue.scope)
        : issueOverview?.dependents ?? [];
      title = `无法移除 ${issuePlugin.displayName}`;
      description = '仍有插件依赖它。没有提供危险绕过操作。';
      actions = [
        { label: '查看完整依赖关系', run: () => go({ name: 'pluginDependencies', pluginId: issuePlugin.pluginId }) },
        { label: '返回插件详情', run: () => go({ name: 'pluginDetail', pluginId: issuePlugin.pluginId }) },
        ...(issueHasTechnicalDetails ? [{ label: showTechnical ? '隐藏技术详情' : '技术详情', run: () => setShowTechnical((value) => !value) }] : []),
      ];
      const dependencyBlockedViewport = policy.mode === 'compact' && showTechnical
        ? { offset: Math.min(Math.max(0, focus - 1), Math.max(0, actions.length - 2)), limit: 2 }
        : actionViewport(actions, policy.mode === 'compact', focus, scrollOffset, pageActionBudget(4));
      content = <Box flexDirection="column">{issueDiagnosticSummary}{showTechnical ? null : <SectionCard title="使用这个依赖的插件">{blockingDependents.map((dependent) => <StaticRow key={dependent.pluginId} title={dependent.displayName} meta={dependentTargetLabel(dependent)} />)}</SectionCard>}<SemanticRows actions={actions} focus={focus} kind="action" compact={policy.mode === 'compact'} offset={dependencyBlockedViewport.offset} limit={dependencyBlockedViewport.limit} /></Box>;
    } else if ((issue.category === 'dependencyMissing' || issue.category === 'dependencyNotReady') && issuePlugin) {
      const dependencyName = issue.dependencyPluginId
        ? props.controller.getPluginOverview(issue.dependencyPluginId)?.displayName ?? issue.dependencyPluginId
        : '必需依赖';
      const dependencyTarget = [
        issue.dependencyPlatform ? platformLabel(issue.dependencyPlatform) : undefined,
        issue.dependencyScope ? scopeLabel(issue.dependencyScope) : undefined,
      ].filter((entry): entry is string => Boolean(entry)).join(' · ');
      content = <Box flexDirection="column">
        {issueDiagnosticSummary}
        {!showTechnical && policy.mode !== 'compact' ? <StatusCard status="warning" title={dependencyName} description="受影响的依赖目标">
          <StaticRow title={issuePlugin.displayName} description="受影响的根插件" meta={issue.platform && issue.scope ? `${platformLabel(issue.platform)} · ${scopeLabel(issue.scope)}` : undefined} />
          {dependencyTarget ? <StaticRow title="依赖目标" meta={dependencyTarget} status="warning" /> : null}
        </StatusCard> : null}
        <SemanticRows actions={actions} focus={focus} kind="action" compact={policy.mode === 'compact'} {...compactTechnicalActionViewport} />
      </Box>;
    } else if (issue.category === 'dependencyTargetUnsupported' && issuePlugin) {
      const issueScope = issue.scope ?? scope;
      const compatible = props.controller.listInstallTargets(issuePlugin.pluginId, issueScope)
        .filter((entry) => entry.compatible);
      title = `无法添加到 ${issue.platform ? platformLabel(issue.platform) : '所选目标平台'}`;
      description = issue.dependencyPluginId
        ? `${props.controller.getPluginOverview(issue.dependencyPluginId)?.displayName ?? issue.dependencyPluginId} 不支持所选目标平台，因此完整插件计划不能运行。`
        : '完整插件计划不支持所选目标平台。';
      actions = [
        ...compatible.map((entry) => ({ label: `只添加到 ${platformLabel(entry.platform)}`, description: '返回目标平台页并使用完整依赖检查', run: () => {
          setScope(issueScope);
          setSelectedTargets([entry.platform]);
          setTargetSelections((current) => ({ ...current, [issueScope]: [entry.platform] }));
          props.controller.beginInstallFlow(issuePlugin.pluginId, issueScope);
          props.controller.setInstallPlatforms([entry.platform]);
          go({ name: 'installTargets', pluginId: issuePlugin.pluginId });
        } })),
        { label: '返回调整目标平台', run: () => {
          setScope(issueScope);
          setSelectedTargets([]);
          setTargetSelections((current) => ({ ...current, [issueScope]: [] }));
          props.controller.beginInstallFlow(issuePlugin.pluginId, issueScope);
          go({ name: 'installTargets', pluginId: issuePlugin.pluginId });
        } },
        { label: '查看依赖关系', run: () => go({ name: 'pluginDependencies', pluginId: issuePlugin.pluginId }) },
        ...(issueHasTechnicalDetails ? [{ label: showTechnical ? '隐藏技术详情' : '技术详情', run: () => setShowTechnical((value) => !value) }] : []),
      ];
      const unsupportedTargetViewport = policy.mode === 'compact' && showTechnical
        ? { offset: Math.min(Math.max(0, focus - 1), Math.max(0, actions.length - 2)), limit: 2 }
        : actionViewport(actions, policy.mode === 'compact', focus, scrollOffset, pageActionBudget(6));
      content = <Box flexDirection="column">{issueDiagnosticSummary}<SemanticRows actions={actions} focus={focus} kind="action" compact={policy.mode === 'compact'} offset={unsupportedTargetViewport.offset} limit={unsupportedTargetViewport.limit} /></Box>;
    } else if (issue.category === 'dependencyGraphInvalid') {
      title = `暂时无法添加 ${issuePlugin?.displayName ?? issue.pluginId ?? '插件'}`;
      description = '来源中的依赖关系无效或安装记录不能安全验证。没有修改任何安装。';
      const sourceId = issue.sourceId;
      if (sourceId) {
        actions = [
          { label: '查看来源问题', description: '进入来源页并重新检查 Catalog', run: () => go({ name: 'sourceDetail', sourceId }) },
          ...actions,
        ];
      }
      content = <Box flexDirection="column">{issueDiagnosticSummary}<SemanticRows actions={actions} focus={focus} kind="action" compact={policy.mode === 'compact'} /></Box>;
    } else {
      const hasRecoveryEvidence = issue.category === 'sourceIdentityChanged'
        || issue.placements || issue.requiredFields;
      const recoveryRows = <>{issue.category === 'sourceIdentityChanged' ? <StaticRow title="来源身份已变化；请确认变更或恢复原来源。" status="warning" compact /> : null}{issue.placements ? <StaticRow title="位置" meta={issue.placements.map(scopeLabel).join('、')} compact /> : null}{issue.requiredFields ? <StaticRow title="字段" meta={sanitizeDiagnosticText(issue.requiredFields.map((field) => field.title).join('、'))} compact /> : null}</>;
      content = <Box flexDirection="column">{issueDiagnosticSummary}{!showTechnical && hasRecoveryEvidence
        ? policy.mode === 'compact' ? recoveryRows : <SectionCard title="恢复证据">{recoveryRows}</SectionCard>
        : null}<SemanticRows actions={actions} focus={focus} kind="action" compact={policy.mode === 'compact'} offset={issueActionViewport.offset} limit={issueActionViewport.limit} /></Box>;
    }
  } else if (route.name === 'reviewPreparing' && snapshot.reviewPreparation) {
    const preparation = snapshot.reviewPreparation;
    const labels = preparation.intent.kind === 'portableInstall'
      ? ['通用 Skills / 安装', '正在准备通用 Skills 安装确认']
      : preparation.intent.kind === 'configSave' || preparation.intent.kind === 'configReset'
        ? ['设置', '正在准备设置确认']
        : preparation.intent.kind === 'sourceMutation'
          ? ['插件来源', '正在准备来源变更确认']
          : ['插件操作', '正在准备插件操作确认'];
    breadcrumb = `${labels[0]} / 准备确认`;
    context = '只读';
    title = preparation.state === 'failed' ? '无法准备确认信息' : labels[1]!;
    description = preparation.state === 'failed'
      ? preparation.message ?? '无法准备确认信息。请返回检查选择，或重试。'
      : '这个阶段只读取和验证状态，不会修改任何安装或设置。';
    help = preparation.state === 'running'
      ? 'Esc 取消 · Ctrl-C 完成后退出'
      : '↑↓ 移动 · Enter 选择 · Esc 返回';
    actions = preparation.state === 'failed' ? [
      { label: '重试', description: '重新读取和验证当前状态', run: () => {
        props.controller.retryReviewPreparation();
        setFocus(0);
        setScrollOffset(0);
      } },
      { label: '返回修改', run: back },
    ] : [];
    const stageState = (state: typeof preparation.stages[number]['state']): 'pending' | 'active' | 'complete' | 'error' =>
      state === 'running' ? 'active' : state === 'completed' ? 'complete' : state === 'failed' ? 'error' : 'pending';
    content = <Box flexDirection="column">
      <SectionCard title="准备步骤">
        {preparation.stages.map((stage) => <ProgressRow
          key={stage.id}
          title={stage.label}
          state={stageState(stage.state)}
          meta={stage.state === 'running' ? '进行中' : stage.state === 'completed' ? '完成' : stage.state === 'failed' ? '失败' : '未开始'}
          compact={policy.mode === 'compact'}
        />)}
      </SectionCard>
      {preparation.currentLabel ? <StaticRow title="当前" meta={preparation.currentLabel} status="muted" /> : null}
      {preparation.code && preparation.message
        ? <Callout status="error" title={preparation.code} description={preparation.message} /> : null}
      {actions.length > 0 ? <SemanticRows actions={actions} focus={focus} kind="action" compact={policy.mode === 'compact'} /> : null}
    </Box>;
  } else if (route.name === 'review' && snapshot.activeReview) {
    const review = snapshot.activeReview;
    const sharedImpactConfirmed = !review.requiresConfirmation
      || confirmedSharedReviewToken === review.reviewToken;
    breadcrumb = `${review.subject.name} / ${review.title}`;
    title = `${snapshot.result?.state === 'stale' ? '状态已变化 · ' : ''}${review.operationKind === 'portableInstall' ? review.title : `确认${review.title}`} ${review.subject.name}`;
    description = snapshot.result?.state === 'stale'
      ? '当前状态已变化。请检查新的变化后再次确认。'
      : review.requiresConfirmation ? '' : review.description;
    actions = [
      ...(review.requiresConfirmation ? [{
        label: sharedImpactConfirmed ? '已确认 shared impact' : '确认 shared impact',
        description: review.sharedImpact.warning ?? '此操作会修改多个插件共享的 Codex native 内容',
        selected: sharedImpactConfirmed,
        run: () => {
          setConfirmedSharedReviewToken(review.reviewToken);
          setFocus(1);
        },
      }] : []),
      { label: review.primaryLabel, description: '执行前将再次检查当前状态', status: review.destructive ? 'error' : undefined, disabled: sharedImpactConfirmed ? undefined : '请先显式确认 shared impact', run: () => {
        if (operationBusy.current) return;
        operationBusy.current = true;
        return props.controller.executeOperation(review.reviewToken).then(() => {
          setFocus(0);
          setScrollOffset(0);
        }).finally(() => {
          operationBusy.current = false;
        });
      } },
      { label: '返回修改', run: review.operationKind === 'portableInstall' && snapshot.portableDraft
        ? async () => {
            if (await refreshPortableDraft(snapshot.portableDraft!.pluginId)) back();
          }
        : back },
    ];
    const groupedChanges = review.changes.some((change) => change.group);
    const compressedReview = policy.mode === 'compact' || review.requiresConfirmation;
    const groupTitle = {
      requested: review.operationKind === 'portableInstall' ? '已选择 Skills · 当前插件' : '你选择的插件',
      dependencies: review.operationKind === 'portableInstall' ? '已选择 Skills · 来自依赖插件' : '必需依赖',
      projectIntent: 'Project intent',
      userIntent: 'User intent',
      sharedCodexNative: 'Shared Codex native',
      userActivation: 'User activation',
      projectActivation: 'Project activation',
      awExtensions: 'AW extensions',
      runtime: 'Codex runtime',
      portableTarget: '安装目标',
      portableInputs: '准备内容',
      portableWarnings: '覆盖冲突',
      configChanges: '设置变更',
      configImpact: '应用影响',
      preserved: '保持不变',
    } as const;
    const changeStatus = (change: OperationReviewChange): ActionItem['status'] =>
      change.kind === 'remove' ? 'error'
        : change.kind === 'warning' ? 'warning'
          : change.kind === 'keep' || change.kind === 'add' ? 'success' : undefined;
    const groupOrder = ['portableWarnings', 'portableTarget', 'configChanges', 'configImpact', 'requested', 'dependencies', 'projectIntent', 'userIntent', 'sharedCodexNative', 'userActivation', 'projectActivation', 'awExtensions', 'runtime', 'preserved', 'portableInputs'] as const;
    const groupedSpecs = groupedChanges
      ? groupOrder.map((group) => ({
          key: group,
          label: groupTitle[group],
          protectedCount: group === 'portableWarnings' || group === 'portableTarget' || group === 'preserved',
          changes: review.changes.filter((change) => (change.group ?? 'requested') === group),
        }))
      : [
          { key: 'warnings', label: '警告', protectedCount: true, changes: review.changes.filter((change) => change.kind === 'warning') },
          { key: 'kept', label: '保持不变', protectedCount: true, changes: review.changes.filter((change) => change.kind === 'keep') },
          { key: 'changes', label: undefined, protectedCount: false, changes: review.changes.filter((change) => change.kind !== 'warning' && change.kind !== 'keep') },
        ];
    const visibleSpecs = groupedSpecs.filter((group) => group.changes.length > 0);
    const headingLines = compressedReview ? 0 : visibleSpecs.filter((group) => group.label).length;
    const staticRowBudget = Math.max(visibleSpecs.length, responsiveBudget(7, 12) - headingLines);
    const allocations = new Map<string, number>(visibleSpecs.map((group) => [group.key, 1]));
    const targetGroup = visibleSpecs.find((group) => group.key === 'portableTarget');
    if (targetGroup && targetGroup.changes.length > 1 && staticRowBudget > visibleSpecs.length) {
      allocations.set(targetGroup.key, 2);
    }
    let remainingRows = staticRowBudget - [...allocations.values()].reduce((sum, count) => sum + count, 0);
    for (const group of visibleSpecs) {
      if (remainingRows <= 0) break;
      const current = allocations.get(group.key) ?? 1;
      const added = Math.min(remainingRows, group.changes.length - current);
      allocations.set(group.key, current + added);
      remainingRows -= added;
    }
    const changeGroups = visibleSpecs.map((group) => {
      const visibleCount = allocations.get(group.key) ?? 1;
      const hiddenCount = group.changes.length - visibleCount;
      return <Box key={group.key} flexDirection="column">
        {!compressedReview && group.label ? <Text bold color={tuiTheme.colors.muted}>{group.label}</Text> : null}
        {group.changes.slice(0, visibleCount).map((change, index) => {
          const retainDescription = change.kind === 'warning' || group.key === 'portableTarget'
            || group.key === 'requested' || group.key === 'dependencies'
            || group.key === 'configChanges' || group.key === 'configImpact';
          const description = retainDescription ? change.description : undefined;
          const compactGroupLabel = group.key === 'requested' ? '根插件'
            : group.key === 'dependencies' ? '依赖'
              : group.key === 'preserved' ? '保持' : group.label;
          const category = compressedReview && index === 0 && compactGroupLabel ? `${compactGroupLabel} · ` : '';
          const count = index === visibleCount - 1 && (hiddenCount > 0 || group.protectedCount)
            ? hiddenCount > 0 ? `另有 ${hiddenCount} 项` : `共 ${group.changes.length} 项`
            : undefined;
          return <ReviewChangeRow
            key={`${change.title}:${index}`}
            title={`${category}${reviewSymbol(change)} ${change.title}${description ? ` · ${description}` : ''}`}
            meta={count}
            status={changeStatus(change)}
            compact
          />;
        })}
      </Box>;
    });
    const technicalDetails = review.technicalDetails ?? [];
    const technicalDetailLimit = responsiveBudget(1, 3);
    const visibleTechnicalDetails = technicalDetails.slice(0, technicalDetailLimit);
    const hiddenTechnicalDetails = technicalDetails.length - visibleTechnicalDetails.length;
    const technicalCardRows = 3 + visibleTechnicalDetails.length;
    const technicalChangeBudget = Math.max(1,
      size.rows - 6 - 3 - (review.equivalentCommand ? 1 : 0) - actions.length - technicalCardRows);
    const prioritizedTechnicalChanges = [
      ...review.changes.filter((change) => change.kind === 'warning'),
      ...review.changes.filter((change) => change.group === 'portableTarget'),
      ...review.changes.filter((change) => change.kind !== 'warning' && change.group !== 'portableTarget'),
    ];
    const visibleTechnicalChanges = prioritizedTechnicalChanges.slice(0, technicalChangeBudget);
    const hiddenTechnicalChanges = review.changes.length - visibleTechnicalChanges.length;
    const technicalChanges = visibleTechnicalChanges.map((change, index) => {
      const category = change.group ? groupTitle[change.group] : undefined;
      return <ReviewChangeRow
        key={`${change.title}:${index}`}
        title={`${category ? `${category} · ` : ''}${reviewSymbol(change)} ${change.title}${change.description ? ` · ${change.description}` : ''}`}
        meta={index === visibleTechnicalChanges.length - 1 && hiddenTechnicalChanges > 0
          ? `另有 ${hiddenTechnicalChanges} 项` : undefined}
        status={changeStatus(change)}
        compact
      />;
    });
    const showEquivalentCommand = Boolean(review.equivalentCommand
      && (!review.requiresConfirmation || showTechnical));
    content = <Box flexDirection="column"><ReviewCard title={review.requiresConfirmation ? undefined : review.subject.name} meta={review.requiresConfirmation ? undefined : `${review.subject.sourceLabel ?? ''} ${review.subject.version ?? ''}`} description={showEquivalentCommand ? review.description : undefined}>{showEquivalentCommand ? <Text>等价命令：{review.equivalentCommand}</Text> : null}{review.catalogBinding ? <><StaticRow title={`Catalog：${review.catalogBinding.sourceId} ${review.catalogBinding.catalogVersion} · 当前使用`} meta={`generation ${review.catalogBinding.generationDigestShort}`} status="success" compact /><StaticRow title="操作期间不检查远端 Catalog" status="success" compact /></> : null}{review.requiresConfirmation ? <StaticRow title="! Shared impact 需要显式确认" meta={review.sharedImpact.pluginIds.length > 0 ? `${review.sharedImpact.pluginIds.length} 个插件` : undefined} description={review.sharedImpact.warning} status="warning" compact /> : null}{showTechnical ? technicalChanges : changeGroups}<SemanticRows actions={actions} focus={focus} kind="action" compact />{compressedReview || showTechnical ? null : <StaticRow title="技术详情（d）" status="muted" />}{showTechnical ? <TechnicalDetails>{visibleTechnicalDetails.map((detail, index) => <StaticRow key={detail} title={detail} meta={index === visibleTechnicalDetails.length - 1 && hiddenTechnicalDetails > 0 ? `另有 ${hiddenTechnicalDetails} 项` : undefined} compact />)}</TechnicalDetails> : null}</ReviewCard></Box>;
  } else if (route.name === 'progress') {
    const portableOperation = snapshot.activeReview?.operationKind === 'portableInstall';
    const configOperation = snapshot.activeReview?.operationKind === 'configSave'
      || snapshot.activeReview?.operationKind === 'configReset';
    const sourceOperation = snapshot.activeReview?.operationKind === 'sourceMutation';
    const issueOperation = snapshot.activeReview?.originIssue;
    breadcrumb = portableOperation ? '通用 Skills / 进度' : issueOperation ? '需要处理 / 进度' : sourceOperation ? '插件来源 / 保存' : configOperation ? '设置 / 进度' : '插件操作 / 进度';
    title = portableOperation ? '正在安装通用 Skills' : issueOperation ? '正在处理问题' : sourceOperation ? '正在保存来源配置' : configOperation ? '正在保存并应用设置' : '正在执行插件操作';
    description = issueOperation ? '完成后会使用新的状态 generation 重新检查问题。' : sourceOperation ? '只原子保存来源配置，不访问网络。' : configOperation ? '先保存所选层，再重新应用当前可见安装位置。' : '请勿关闭当前终端。';
    help = 'Ctrl-C 完成后退出';
    const progress = snapshot.progress;
    const elapsedSeconds = Math.max(0, Math.floor(((progress.elapsedMs
      ?? (progress.startedAtMs === undefined ? 0 : Date.now() - progress.startedAtMs))) / 1_000));
    const latestMessage = progress.messages.at(-1);
    const technicalMessageLimit = portableOperation ? responsiveBudget(1, 3) : responsiveBudget(4, 4);
    const technicalMessages = progress.messages.slice(-technicalMessageLimit);
    const hiddenTechnicalMessages = progress.messages.length - technicalMessages.length;
    const dependencyProgress = snapshot.progressTargets.length > 0;
    const currentPhase = progress.current?.phase ?? '';
    const failedProgress = snapshot.progressTargets.some((entry) => entry.state === 'failed');
    const validationActive = currentPhase.includes('检查写入结果')
      || currentPhase.includes('读取最终状态')
      || (currentPhase.includes('验证') && currentPhase !== '验证当前状态'
        && !currentPhase.includes('验证设置值'));
    const preflightActive = !validationActive && (currentPhase.includes('检查')
      || currentPhase === '验证当前状态' || currentPhase.includes('验证设置值'));
    const executionActive = Boolean(currentPhase) && !preflightActive && !validationActive && !failedProgress;
    const progressLabel = (entry: typeof snapshot.progressTargets[number]): { label: string; status: ActionItem['status'] } => {
      if (entry.state === 'kept') return { label: '已保留', status: 'success' };
      if (entry.state === 'completed') return { label: '已完成', status: 'success' };
      if (entry.state === 'running') return { label: '正在添加', status: 'info' };
      if (entry.state === 'failed') return { label: '失败', status: 'error' };
      if (entry.state === 'skipped') return { label: '未执行 · 依赖未完成', status: 'warning' };
      return { label: entry.relation === 'requested' ? '等待依赖' : '未开始', status: 'muted' };
    };
    const prioritizedProgressTargets = [...snapshot.progressTargets].sort((left, right) => {
      const priority = (entry: typeof left): number => entry.state === 'failed' ? 0
        : entry.state === 'running' ? 1
          : entry.relation === 'requested' ? 2
            : entry.state === 'skipped' ? 3 : 4;
      return priority(left) - priority(right);
    });
    const progressStepRows = policy.mode === 'compact' ? 4 : 5;
    const progressTargetAndMessageBudget = pageActionBudget()
      - 2
      - progressStepRows
      - 3
      - (exitAfterBusy ? 3 : 0);
    const dependencyMessageLimit = progressTargetAndMessageBudget
      >= (policy.mode === 'compact' ? 2 : 3) + 1
      ? Math.min(1, showTechnical ? technicalMessages.length : latestMessage ? 1 : 0)
      : 0;
    const progressTargetBudget = progressTargetAndMessageBudget - dependencyMessageLimit;
    const progressTargetLimit = prefixRowLimit(
      prioritizedProgressTargets.map(() => policy.mode === 'compact' ? 1 : 2),
      progressTargetBudget,
    );
    const visibleProgressTargets = prioritizedProgressTargets.slice(0, progressTargetLimit);
    const hiddenProgressTargets = snapshot.progressTargets.length - visibleProgressTargets.length;
    const targetStates = snapshot.progressTargets.map((entry) => entry.state);
    const executionComplete = targetStates.length > 0
      && targetStates.every((state) => state === 'completed' || state === 'kept');
    const executionStarted = targetStates.some((state) => state === 'running' || state === 'completed'
      || state === 'failed' || state === 'skipped');
    const relationStep = currentPhase === '验证当前状态' || preflightActive ? 'active' as const : 'complete' as const;
    const planStep = relationStep === 'active' ? 'pending' as const : 'complete' as const;
    const closureStep = failedProgress ? 'error' as const
      : executionComplete ? 'complete' as const
        : executionStarted || executionActive ? 'active' as const : 'pending' as const;
    const verificationStep = failedProgress && validationActive ? 'error' as const
      : validationActive ? 'active' as const : 'pending' as const;
    const portableDraft = snapshot.portableDraft;
    const portableReviewProviderIds = snapshot.activeReview?.changes
      .filter((change) => change.group === 'requested' || change.group === 'dependencies')
      .flatMap((change) => change.pluginId ? [change.pluginId] : []) ?? [];
    const portableProviderCount = new Set(portableReviewProviderIds.length > 0
      ? portableReviewProviderIds
      : portableDraft?.candidates.filter((candidate) => candidate.selected)
        .map((candidate) => candidate.providerPluginId) ?? []).size;
    const portableSelectedCount = portableDraft?.selectedCount
      ?? snapshot.activeReview?.changes.filter((change) => change.group === 'requested' || change.group === 'dependencies').length
      ?? 0;
    const portablePreparing = currentPhase.includes('检查插件依赖并生成候选');
    const portableInstalling = currentPhase.includes('安装已选择的 Skills');
    const portableVerifying = currentPhase.includes('验证安装结果');
    const portableStep = portableVerifying ? 3 : portableInstalling ? 2 : portablePreparing ? 1 : 0;
    const portableProgressState = (step: number): 'pending' | 'active' | 'complete' | 'error' => {
      if (failedProgress && step === portableStep) return 'error';
      if (step < portableStep) return 'complete';
      if (step === portableStep) return 'active';
      return 'pending';
    };
    const portableProgressMeta = (step: number): string => {
      const state = portableProgressState(step);
      if (state === 'complete') return '完成';
      if (state === 'error') return '失败';
      if (state === 'pending') return '未开始';
      return step === 2 ? '正在安装' : step === 3 ? '正在验证' : step === 1 ? '正在生成' : '正在检查';
    };
    const compactPortableProgress = policy.mode === 'compact' && showTechnical;
    content = portableOperation ? <StatusCard status={failedProgress ? 'error' : 'info'} title="Skills CLI">
      <ProgressRow title="检查插件和依赖" description={`${snapshot.activeReview?.subject.name ?? '当前插件'} · ${portableDraft?.dependencySummary?.directCount ?? 0} 个直接依赖`} meta={portableProgressMeta(0)} state={portableProgressState(0)} compact={compactPortableProgress} />
      <ProgressRow title="生成已选候选 Skills" description={`${portableProviderCount} 个 provider 提供 ${portableSelectedCount} 个 Skills`} meta={portableProgressMeta(1)} state={portableProgressState(1)} compact={compactPortableProgress} />
      <ProgressRow title={`安装已选择的 ${portableSelectedCount} 个 Skills`} description={`Agent：${portableDraft?.agentMode === 'explicit' ? portableDraft.requestedAgents.join('、') : 'Skills CLI 默认选择'}`} meta={portableProgressMeta(2)} state={portableProgressState(2)} compact={compactPortableProgress} />
      <ProgressRow title="验证结果" description="逐项确认所选 Skill 的安装目标" meta={portableProgressMeta(3)} state={portableProgressState(3)} compact={compactPortableProgress} />
      {showTechnical ? <TechnicalDetails>{technicalMessages.map((message, index) => <StaticRow key={`${index}:${message}`} title={message} compact />)}{hiddenTechnicalMessages > 0 ? <StaticRow title={`另有 ${hiddenTechnicalMessages} 条技术消息`} status="muted" compact /> : null}</TechnicalDetails> : null}
    </StatusCard> : <StatusCard status="info">
      {dependencyProgress ? <>
        <ProgressRow title="检查依赖关系" state={relationStep} />
        <ProgressRow title="生成执行计划" state={planStep} />
        <ProgressRow title="执行依赖闭包" description={progress.current?.target ? `当前：${progress.current.target}` : undefined} meta={`${elapsedSeconds}s`} state={closureStep} compact={policy.mode === 'compact'} />
        <ProgressRow title="验证完整结果" state={verificationStep} />
      </> : <>
        <ProgressRow title={sourceOperation ? '检查来源操作输入' : configOperation ? '验证设置值' : '检查兼容性'} state={!currentPhase ? 'pending' : preflightActive ? 'active' : 'complete'} />
        <ProgressRow title={progress.current?.phase || (sourceOperation ? '保存来源配置' : configOperation ? '保存设置层并重新应用' : '连接到所选目标平台')} description={progress.current?.target ? `当前：${progress.current.target}` : undefined} meta={`${elapsedSeconds}s`} state={failedProgress ? 'error' : executionActive ? 'active' : validationActive ? 'complete' : 'pending'} compact={policy.mode === 'compact'} />
        <ProgressRow title="验证结果" state={failedProgress ? 'error' : validationActive ? 'active' : 'pending'} />
      </>}
      {dependencyProgress ? <SectionCard title="执行目标" meta={`${snapshot.progressTargets.length} 个目标`}>{visibleProgressTargets.map((entry) => {
        const state = progressLabel(entry);
        const relation = entry.relation === 'requested' ? '你选择的插件' : entry.relation === 'direct' ? '直接依赖' : '间接依赖';
        const title = props.controller.getPluginOverview(entry.pluginId)?.displayName
          ?? entry.pluginId.split('/').at(-1);
        return <ResultRow key={`${entry.pluginId}:${entry.platform}:${entry.scope}`} title={title} description={relation} meta={state.label} status={state.status ?? 'muted'} compact={policy.mode === 'compact'} />;
      })}{hiddenProgressTargets > 0 ? <StaticRow title={`另有 ${hiddenProgressTargets} 个目标`} status="muted" compact /> : null}</SectionCard> : null}
      {!showTechnical && latestMessage && (!dependencyProgress || dependencyMessageLimit > 0) ? <StaticRow title={latestMessage} status="muted" compact /> : null}
      {showTechnical ? (dependencyProgress
        ? dependencyMessageLimit > 0 ? technicalMessages.slice(-dependencyMessageLimit) : []
        : technicalMessages).map((message, index) => <StaticRow key={`${index}:${message}`} title={message} compact />) : null}
      {exitAfterBusy ? <Callout status="warning" title="操作完成后退出" /> : null}
    </StatusCard>;
  } else if (route.name === 'result' && snapshot.result) {
    const result = snapshot.result;
    const partial = result.state === 'partial';
    const blocked = result.state === 'blocked';
    breadcrumb = '插件操作 / 结果';
    const resultSummary = result.state === 'succeeded' || result.state === 'partial'
      ? result.summary
      : result.state === 'blocked' ? result.summary : undefined;
    const action = resultSummary?.action;
    const operationKind = 'operationKind' in result ? result.operationKind : undefined;
    const portableOperation = operationKind === 'portableInstall';
    const portableReceipt = result.state === 'succeeded' || result.state === 'partial'
      ? result.summary.portable : undefined;
    const portableInstallFailed = portableReceipt?.failureCode === 'portableSkillsCliInstallFailed';
    const portableOriginIsDetail = 'returnRoute' in result
      && result.returnRoute?.name === 'pluginDetail';
    const configOperation = operationKind === 'configSave' || operationKind === 'configReset'
      ? operationKind : undefined;
    const successfulConfigOperation = configOperation !== undefined && !blocked && !partial;
    const sourceOperation = operationKind === 'sourceMutation';
    const issueOperation = result.originIssue;
    const completedTitle = {
      install: '✓ 插件添加完成',
      upgrade: '✓ 插件升级完成',
      reinstall: '✓ 插件重新安装完成',
      uninstall: '✓ 插件移除完成',
      cleanup: '✓ 插件清理完成',
      sync: '✓ 插件同步完成',
    }[action ?? 'install'];
    title = portableOperation
      ? blocked ? '× 通用 Skills 安装被阻止'
        : partial ? '! 通用 Skills 结果未完全完成' : '✓ 通用 Skills 已安装'
      : blocked && result.writeMayHaveCompleted
      ? '× 写入结果未确认'
      : issueOperation
      ? blocked || partial ? '× 问题仍未解决' : '✓ 问题已处理'
      : sourceOperation
      ? blocked ? '× 来源操作未完成' : '✓ 来源配置已保存'
      : configOperation
      ? blocked
        ? '× 设置未确认保存'
        : partial ? '! 设置已保存，但部分应用失败' : '✓ 设置已保存并应用'
      : partial ? '! 插件操作只完成了一部分'
        : blocked ? result.code === 'operationFailed' ? '× 插件操作没有完成' : '× 插件操作未完成'
          : completedTitle;
    description = portableOperation
      ? blocked
        ? result.code === 'operationReviewExpired' || result.code === 'reviewTicketExpired'
          ? 'Review 已过期，写入未开始。请返回修改并重新确认。'
          : result.code === 'operationReviewStale'
            ? '安装证据已变化，写入被阻止。请返回修改并重新确认。'
            : result.writeMayHaveCompleted
              ? '写入结果无法确认。请检查外部 Skills 状态后重试。'
              : '安装在写入前被阻止。请返回修改后重试。'
        : portableInstallFailed ? 'Skills CLI 安装失败，可能已有部分目标写入。可以修改 Agent 或使用原选择重试。' : partial ? '无法确认全部已选择 Skills。' : '所选 Skills 已通过安装验证。'
      : blocked && result.writeMayHaveCompleted
      ? result.message
      : issueOperation
      ? blocked
        ? result.code === 'issueVerificationFailed'
          ? '写入可能已完成，但当前无法确认。请重新检查状态。'
          : result.code === 'issueStillPresent'
            ? '写入已完成，但重新检查后原问题仍然存在。'
            : '操作被安全阻止。可返回问题详情后重试。'
        : '状态已重新加载；原问题已确认消失。'
      : sourceOperation
      ? blocked
        ? result.writeMayHaveCompleted
          ? '来源配置可能已保存。请重新检查来源列表。'
          : '来源操作未执行。草稿已保留，可返回修改。'
        : '来源配置已保存。请在终端运行 aw catalog source sync，然后重新加载 TUI。'
      : blocked ? result.message
        : configOperation ? '设置层已经更新。' : '状态已刷新。';
    const pluginId = resultSummary?.pluginId
      ?? ('pluginId' in result ? result.pluginId : undefined);
    const configOrigin = successfulConfigOperation && pluginId
      ? props.controller.configOrigin(pluginId)
      : undefined;
    const dependencyTargets = resultSummary?.targets?.some((target) => target.relation) ?? false;
    const blockedDependencyFailure = blocked && result.code === 'operationFailed' && dependencyTargets;
    const dependencyRecovery = (partial && dependencyTargets) || blockedDependencyFailure;
    if (blockedDependencyFailure) {
      title = '× 依赖安装没有完成';
      description = '依赖目标失败，后续目标未执行。可以查看失败项或重试失败的依赖。';
    }
    const failedTarget = resultSummary?.targets
      ?.filter((target) => target.state === 'failed')
      .sort((left, right) => [left.pluginId ?? '', left.platform, left.scope].join('\0')
        .localeCompare([right.pluginId ?? '', right.platform, right.scope].join('\0'), 'en'))[0];
    const failedTargetPluginId = failedTarget?.pluginId;
    const failedPluginId = dependencyRecovery
      ? failedTargetPluginId
      : failedTargetPluginId && props.controller.getPluginOverview(failedTargetPluginId)
        ? failedTargetPluginId : pluginId;
    const failedPluginPlatforms = failedPluginId
      ? props.controller.getPluginOverview(failedPluginId)?.supportedPlatforms : undefined;
    const failedIssue = failedPluginId && failedTarget
      ? props.controller.listUserIssues().find((candidate) =>
          (candidate.pluginId === failedPluginId || candidate.dependencyPluginId === failedPluginId)
          && candidate.platform === failedTarget.platform
          && (candidate.pluginId === failedPluginId
            ? candidate.scope === failedTarget.scope
            : candidate.dependencyPlatform === failedTarget.platform
              && candidate.dependencyScope === failedTarget.scope)
          && (candidate.category === 'incompleteInstallation' || candidate.category === 'diagnostic'
            || candidate.category === 'dependencyNotReady' || candidate.category === 'dependencyMissing'))
      : undefined;
    const failedTargetState = failedPluginId && failedTarget
      ? props.controller.getTargetState(failedPluginId, failedTarget.platform, failedTarget.scope)
      : undefined;
    const retryAction = partialRetryAction(operationKind, action, failedTargetState);
    const retryIssueAction = retryAction
      ? failedIssue?.actions.find((candidate) => (candidate.writeAction === retryAction || candidate.id === retryAction)
        && (candidate.pluginId ?? failedIssue.pluginId) === failedPluginId
        && (candidate.platform ?? failedIssue.platform) === failedTarget?.platform
        && (candidate.scope ?? failedIssue.scope) === failedTarget?.scope)
      : undefined;
    actions = portableOperation
      ? blocked || partial ? [
          { label: blocked || partial ? '返回修改' : portableOriginIsDetail ? '返回插件详情' : '返回插件预览', run: async () => {
            if (!pluginId) {
              leaveResult();
              return;
            }
            if (!blocked && !partial) {
              props.controller.discardPortableDraft();
              leaveResult();
              return;
            }
            if (!await refreshPortableDraft(pluginId)) return;
            if (portableInstallFailed && portableReceipt?.agentMode === 'explicit') {
              props.controller.resetPortableFlowToPreview(
                pluginId,
                { name: 'portableAgentInput', pluginId },
                true,
              );
              return;
            }
            props.controller.resetPortableFlowToPreview(
              pluginId,
              { name: 'portableSkillSelect', pluginId },
              true,
            );
          } },
          { label: blocked || partial ? '重试' : '再安装其他 Skills…', run: async () => {
            if (!pluginId) return;
            if (blocked || partial) {
              props.controller.resetPortableFlowToPreview(
                pluginId,
                { name: 'portableSkillSelect', pluginId },
                true,
              );
              await beginPortableReview(pluginId, snapshot.portableDraft?.scope ?? 'project');
              return;
            }
            props.controller.resetPortableFlowToPreview(pluginId);
            await beginPortable(pluginId);
          } },
          { label: portableOriginIsDetail ? '返回插件详情' : '返回插件预览', run: () => { if (pluginId) props.controller.resetPortableFlowToPreview(pluginId); } },
        ] : [
          { label: portableOriginIsDetail ? '返回插件详情' : '返回插件预览', run: () => {
            props.controller.discardPortableDraft();
            leaveResult();
          } },
          { label: '再安装其他 Skills…', run: async () => {
            if (!pluginId) return;
            props.controller.resetPortableFlowToPreview(pluginId);
            await beginPortable(pluginId);
          } },
        ]
      : issueOperation && !dependencyRecovery
      ? blocked || partial
        ? [
            { label: '返回问题详情', run: () => blocked
              ? leaveResult()
              : failedIssue
                ? leaveResult({ name: 'issueDetail', issueId: failedIssue.issueId })
                : pluginId && failedTarget
                  ? leaveResult({ name: 'platform', pluginId, platform: failedTarget.platform })
                  : leaveResult() },
            { label: '重新检查问题', run: () => leaveResult({ name: 'issueList' }) },
          ]
        : [
            { label: '查看问题列表', run: () => leaveResult({ name: 'issueList' }) },
            { label: '返回首页', run: () => leaveResult({ name: 'home' }) },
          ]
      : sourceOperation
      ? [{ label: blocked ? '返回修改' : '查看来源', run: () => blocked ? leaveResult() : leaveResult({ name: 'sourceList' }) }, { label: '返回首页', run: () => leaveResult({ name: 'home' }) }]
      : configOperation && blocked
      ? [
          { label: '返回设置', run: () => leaveResult() },
          { label: '返回首页', run: () => leaveResult({ name: 'home' }) },
        ]
      : [{ label: partial || blockedDependencyFailure ? '查看失败项' : successfulConfigOperation && configOrigin
        ? configOrigin?.name === 'pluginPreview' ? '返回插件预览' : '返回插件详情'
        : configOperation ? '查看插件'
          : action === 'uninstall' || action === 'cleanup' ? '返回插件详情' : '查看插件', run: () => {
      if (successfulConfigOperation && configOrigin) {
        leaveResult();
        return;
      }
      if ((partial || blockedDependencyFailure) && failedPluginId && failedTarget) {
        if (failedIssue) leaveResult({ name: 'issueDetail', issueId: failedIssue.issueId });
        else if (failedPluginPlatforms?.includes(failedTarget.platform)) {
          leaveResult({ name: 'platform', pluginId: failedPluginId, platform: failedTarget.platform });
        } else if (snapshot.viewModel?.plugins.some((entry) => entry.pluginId === failedPluginId)) {
          leaveResult({ name: 'pluginDetail', pluginId: failedPluginId });
        } else leaveResult({ name: 'pluginList', mode: 'installed' });
      } else if (pluginId && snapshot.viewModel?.plugins.some((entry) => entry.pluginId === pluginId)) {
        leaveResult({ name: 'pluginDetail', pluginId });
      }
      else leaveResult({ name: 'pluginList', mode: 'installed' });
    } }, ...((partial || blockedDependencyFailure) && failedPluginId && failedTarget && retryAction ? [{
      label: '重试失败部分…',
      run: () => {
        const issueIntent = failedIssue && retryIssueAction
          ? issueWriteIntent(failedIssue, retryIssueAction)
          : undefined;
        return beginReview(issueIntent ?? {
          kind: 'pluginWrite',
          action: retryAction,
          pluginId: failedPluginId!,
          platform: failedTarget.platform,
          scope: failedTarget.scope,
        });
      },
    }] : []), { label: '返回首页', run: () => leaveResult({ name: 'home' }) }];
    const visibleMessages = resultSummary?.messages?.slice(policy.mode === 'compact' ? -2 : -4) ?? [];
    const resultTargetName = (target: NonNullable<OperationResultSummary['targets']>[number]): string =>
      target.pluginId
        ? props.controller.getPluginOverview(target.pluginId)?.displayName
          ?? target.pluginId.split('/').at(-1)!
        : `${platformLabel(target.platform)} · ${scopeLabel(target.scope)}`;
    const resultStatus = blocked ? 'error' : partial ? 'warning' : 'success';
    const resultTargets = resultSummary?.targets ?? [];
    const hasPreservedTarget = resultTargets.some((target) =>
      target.state === 'completed' || target.state === 'kept');
    const prioritizedTargets = [...resultTargets].sort((left, right) => {
      const priority = (target: typeof left): number => target.state === 'failed' ? 0
        : target.state === 'skipped' ? 1 : target.relation === 'requested' ? 2 : 3;
      return priority(left) - priority(right);
    });
    const resultActionViewport = actionViewport(actions, true, focus, scrollOffset, pageActionBudget(8));
    const resultExtraRows = (resultSummary?.elapsedMs !== undefined ? 1 : 0)
      + visibleMessages.length
      + (partial && hasPreservedTarget && resultTargets.some((target) => target.state === 'skipped') ? 1 : 0);
    const resultTargetLimit = prefixRowLimit(
      prioritizedTargets.map(() => policy.mode === 'compact' ? 1 : 2),
      pageActionBudget() - 3 - resultActionViewport.limit - resultExtraRows,
    );
    const visibleResultTargets = prioritizedTargets.slice(0, resultTargetLimit);
    const hiddenResultTargets = resultTargets.length - visibleResultTargets.length;
    const portableMissingSkills = new Set(portableReceipt?.missing.map((entry) => entry.skill) ?? []);
    const portableSelectedSkills = portableReceipt?.selectedSkills
      ?? snapshot.portableDraft?.candidates.filter((candidate) => candidate.selected).map((candidate) => candidate.name)
      ?? [];
    const prioritizedPortableSkills = [...portableSelectedSkills].sort((left, right) =>
      Number(portableMissingSkills.has(right)) - Number(portableMissingSkills.has(left)));
    const portableTechnicalSummary = showTechnical && (partial || blocked);
    const portableSkillLimit = showTechnical ? 1 : responsiveBudget(2, 6);
    const visiblePortableSkills = prioritizedPortableSkills.slice(0, portableSkillLimit);
    const hiddenPortableSkills = prioritizedPortableSkills.length - visiblePortableSkills.length;
    const portableRows = visiblePortableSkills.map((skill) => {
      const missing = portableMissingSkills.has(skill);
      const status = blocked || portableReceipt?.verificationUnknown ? 'warning' as const
        : missing ? 'warning' as const : 'success' as const;
      const meta = blocked ? result.writeMayHaveCompleted ? '结果未知' : '未执行'
        : portableReceipt?.verificationUnknown ? '结果未知'
        : missing ? '未完成 · 缺少目标' : '已安装';
      return <ResultRow key={skill} title={skill} meta={meta} status={status} compact />;
    });
    const compactTechnicalRows = portableReceipt ? [
      portableReceipt.failureCode
        ? <StaticRow key="failure-code" title="failure code" meta={portableReceipt.failureCode} compact />
        : <StaticRow key="materialization-digest" title="materialization digest" meta={portableReceipt.materializationDigest} compact />,
      <StaticRow key="folded-fields" title="其余技术字段已折叠" meta="摘要已保留" status="muted" compact />,
    ] : [
      <StaticRow key="failure-code" title="failure code" meta={'code' in result ? result.code : 'operationFailed'} compact />,
      <StaticRow key="folded-fields" title="其余技术字段已折叠" meta="本次写入没有安全 receipt" status="muted" compact />,
    ];
    content = portableOperation ? <Box flexDirection="column">
      {portableTechnicalSummary ? <>
        {portableRows}
        {hiddenPortableSkills > 0 ? <StaticRow title={`另有 ${hiddenPortableSkills} 个 Skills`} status="muted" compact /> : null}
        {portableReceipt?.recovery ? <StaticRow title="安全恢复" meta={portableReceipt.recovery} status="warning" compact /> : null}
        <TechnicalDetails>{compactTechnicalRows}</TechnicalDetails>
      </> : <>
      <ResultCard status={resultStatus} title={blocked ? '安装未开始或结果未确认' : partial ? '部分 Skills 未确认' : '通用 Skills 安装结果'}>
        {portableRows}
        {hiddenPortableSkills > 0 ? <StaticRow title={`另有 ${hiddenPortableSkills} 个 Skills`} status="muted" compact /> : null}
        {portableReceipt ? <StaticRow title={`Agent：${portableReceipt.agentMode === 'automatic' ? 'Skills CLI 默认选择' : portableReceipt.requestedAgents.join('、')}`} meta={`范围：${scopeLabel(portableReceipt.scope)}`} compact /> : null}
        {portableReceipt?.recovery ? policy.mode === 'compact'
          ? <StaticRow title="安全恢复" meta={portableReceipt.recovery} status="warning" compact />
          : <Callout status="warning" title="安全恢复" description={portableReceipt.recovery} /> : null}
        {showTechnical && portableReceipt ? <TechnicalDetails>
          {portableReceipt.failureCode ? <StaticRow title="failure code" meta={portableReceipt.failureCode} compact /> : null}
          <StaticRow title="verification missing" meta={String(portableReceipt.missing.length)} compact />
          <StaticRow title="Skills CLI version" meta={portableReceipt.skillsCliVersion} compact />
          {partial || blocked
            ? <StaticRow title="另有技术字段已折叠" meta="materialization digest · elapsed" status="muted" compact />
            : <>
                <StaticRow title="materialization digest" meta={portableReceipt.materializationDigest} compact />
                {resultSummary?.elapsedMs !== undefined ? <StaticRow title="elapsed" meta={`${resultSummary.elapsedMs} ms`} compact /> : null}
              </>}
        </TechnicalDetails> : null}
        {showTechnical && !portableReceipt ? <TechnicalDetails>
          <StaticRow title="failure code" meta={'code' in result ? result.code : 'operationFailed'} compact />
          <StaticRow title="其余技术字段" meta="本次写入没有生成安全 receipt" status="muted" compact />
        </TechnicalDetails> : null}
      </ResultCard>
      </>}
      <SemanticRows actions={actions} focus={focus} kind="action" compact offset={resultActionViewport.offset} limit={resultActionViewport.limit} />
    </Box> : <Box flexDirection="column"><ResultCard status={resultStatus} title={blockedDependencyFailure ? '依赖安装没有完成' : blocked ? `${result.writeMayHaveCompleted ? '结果未确认' : '操作未完成'} · ${result.code}` : sourceOperation ? '来源配置写入已完成' : dependencyTargets ? partial ? '依赖安装没有全部完成' : '操作已完成' : resultSummary?.message ?? '状态已变化，请重新确认'}>{visibleResultTargets.map((target) => { const state = operationTargetStateLabel(target.state); const relation = target.relation === 'requested' ? '你选择的插件' : target.relation === 'direct' ? '直接依赖' : target.relation === 'transitive' ? '间接依赖' : undefined; return <ResultRow key={`${target.pluginId ?? ''}:${target.platform}:${target.scope}`} title={resultTargetName(target)} description={relation} meta={state.label} status={state.status ?? 'muted'} compact={policy.mode === 'compact'} />; })}{hiddenResultTargets > 0 ? <StaticRow title={`另有 ${hiddenResultTargets} 个目标`} status="muted" compact /> : null}{partial && hasPreservedTarget && resultTargets.some((target) => target.state === 'skipped') ? <StaticRow title="未执行的目标没有写入；已完成或已保留的目标保持可用。" status="muted" compact /> : null}{resultSummary?.elapsedMs !== undefined ? <StaticRow title="已用时" meta={`${Math.floor(resultSummary.elapsedMs / 1_000)}s`} /> : null}{visibleMessages.map((message, index) => <StaticRow key={`${index}:${message}`} title={message} status="muted" compact />)}</ResultCard><SemanticRows actions={actions} focus={focus} kind="action" compact offset={resultActionViewport.offset} limit={resultActionViewport.limit} /></Box>;
  } else if (route.name === 'pluginAbout' && plugin) {
    breadcrumb = `${plugin.displayName} / 关于`;
    title = plugin.displayName;
    description = plugin.description;
    actions = [{ label: '查看技术详情', run: () => go({ name: 'pluginTechnical', pluginId: plugin.pluginId }) }, { label: '查看来源', run: () => go({ name: 'sourceDetail', sourceId: plugin.sourceId }) }];
    content = <Box flexDirection="column"><SectionCard><StaticRow title="版本" meta={plugin.version ?? '未知'} /><StaticRow title="来源" meta={plugin.sourceLabel} /><StaticRow title="可用目标平台" meta={plugin.supportedPlatforms.map(platformLabel).join('、')} /><StaticRow title="配置" meta={`${plugin.configFieldCount} 个字段`} /></SectionCard><SemanticRows actions={actions} focus={focus} kind="action" compact={policy.mode === 'compact'} /></Box>;
  } else if (route.name === 'pluginTechnical' && plugin) {
    breadcrumb = `${plugin.displayName} / 技术详情`;
    context = '只读';
    title = '安装与身份详情';
    description = '默认页面不会展示这些内部信息。';
    actions = [{ label: '返回插件', run: back }];
    const prioritizedComponents = [...plugin.technicalComponents].sort((left, right) => {
      const priority = (state: typeof left.state): number => state === 'error' ? 0
        : state === 'partial' ? 1 : state === 'absent' ? 2 : 3;
      return priority(left.state) - priority(right.state);
    });
    const detailRowBudget = responsiveBudget(9, 15);
    const componentRowBudget = Math.max(1,
      detailRowBudget - 2 - plugin.installedPlacements.length);
    const componentLimit = prioritizedComponents.length > componentRowBudget
      ? Math.max(1, componentRowBudget - 1)
      : componentRowBudget;
    const visibleComponents = prioritizedComponents.slice(0, componentLimit);
    const hiddenComponents = prioritizedComponents.length - visibleComponents.length;
    content = <Box flexDirection="column"><TechnicalDetails><StaticRow title="canonical pluginId" meta={plugin.pluginId} /><StaticRow title="来源" meta={plugin.sourceId} />{plugin.installedPlacements.map((placement) => <StaticRow key={placement.platform} title={`${platformLabel(placement.platform)} target`} meta={placementStatus(placement).value} />)}{visibleComponents.map((component) => <StaticRow key={`${component.platform}:${component.scope}:${component.key}`} title={`组件 · ${component.state === 'absent' ? '缺失' : component.state}${component.errorCode ? ` · ${component.errorCode}` : ''} · ${component.key} · ${platformLabel(component.platform)} · ${scopeLabel(component.scope)}`} />)}{hiddenComponents > 0 ? <StaticRow title={`另有 ${hiddenComponents} 个组件`} status="muted" compact /> : null}</TechnicalDetails><SemanticRows actions={actions} focus={focus} kind="action" compact={policy.mode === 'compact'} /></Box>;
  } else {
    breadcrumb = '后续阶段';
    title = '此业务页将在后续阶段接入';
    description = '当前阶段只实现插件发现、安装和维护页面。';
    actions = [{ label: '返回上一页', run: back }];
    content = <SemanticRows actions={actions} focus={focus} kind="action" compact={policy.mode === 'compact'} />;
  }

  if (canOpenHelp && supportsTechnicalDetails) {
    const technicalHelp = route.name === 'progress' ? 'd 技术进度' : 'd 技术详情';
    const remainingHelp = help.replace(' · ? 帮助', '').replace('? 帮助 · ', '');
    help = `${technicalHelp} · ? 帮助 · ${remainingHelp}`;
  } else if (canOpenHelp && !help.includes('? 帮助')) {
    help = `? 帮助 · ${help}`;
  }

  const targetActionSignature = route.name === 'installTargets' && route.view !== 'blocked'
    ? actions.map((action) => String(Boolean(action.disabled))).join(',')
    : '';

  useEffect(() => {
    if (!targetActionSignature || !actions[focus]?.disabled) return;
    const firstEnabled = actions.findIndex((action) => !action.disabled);
    if (firstEnabled < 0) return;
    setFocus(firstEnabled);
    setScrollOffset(0);
  }, [focus, targetActionSignature]);

  useEffect(() => {
    if (!dynamicActionIds || dynamicActionSignature === undefined) {
      dynamicMenuFocus.current = undefined;
      return;
    }
    if (effectiveFocus !== focus) {
      setFocus(effectiveFocus);
      setScrollOffset(0);
    }
    dynamicMenuFocus.current = {
      routeKey,
      actionIds: dynamicActionSignature,
      focusedActionId: dynamicActionIds[effectiveFocus],
    };
  }, [dynamicActionSignature, routeKey]);

  const runAction = (action: ActionItem | undefined): void => {
    if (!action || action.disabled) return;
    try {
      const pending = action.run?.();
      if (pending) void pending.catch((error: unknown) => {
        if (error instanceof Error && error.name === 'AbortError') return;
        setActionError('操作未完成。请重新检查后重试。');
      });
    } catch {
      setActionError('操作未完成。请重新检查后重试。');
    }
  };

  useInput((input, key) => {
    if (!overlay && route.name === 'reviewPreparing' && snapshot.reviewPreparation?.state === 'failed'
      && (key.escape || input.toLowerCase() === 'b')) {
      back();
      return;
    }
    if (preparationRunning) {
      if (key.escape || input.toLowerCase() === 'b') {
        back();
      } else if (input.toLowerCase() === 'q' || (key.ctrl && input.toLowerCase() === 'c')) {
        setExitAfterPreparation(true);
      }
      return;
    }
    if (busy) {
      if (overlay === 'help') {
        if (key.escape || key.return || input.toLowerCase() === 'b' || input === '?') {
          setOverlay(undefined);
        } else if (key.ctrl && input.toLowerCase() === 'c') {
          setExitAfterBusy(true);
        }
      } else if (input.toLowerCase() === 'q' || (key.ctrl && input.toLowerCase() === 'c')) {
        setExitAfterBusy(true);
      } else if (canOpenHelp && input === '?') {
        setOverlayFocus(0);
        setOverlay('help');
      } else if (!tooSmall && supportsTechnicalDetails && input.toLowerCase() === 'd') {
        setShowTechnical((value) => !value);
      }
      return;
    }
    if (tooSmall) {
      if (input.toLowerCase() === 'q' || (key.ctrl && input.toLowerCase() === 'c')) {
        requestExit({ code: snapshot.phase === 'error' ? 1 : 0, reason: snapshot.phase === 'error' ? 'initialError' : 'user' });
      }
      return;
    }
    if (overlay) {
      if (key.ctrl && input.toLowerCase() === 'c') {
        requestExit({ code: snapshot.phase === 'error' ? 1 : 0, reason: snapshot.phase === 'error' ? 'initialError' : 'user' });
        return;
      }
      if (key.escape || input.toLowerCase() === 'b' || input === '?') {
        setOverlay(undefined);
        return;
      }
      if (key.leftArrow || key.rightArrow || key.upArrow || key.downArrow) {
        if (overlay !== 'help') setOverlayFocus((value) => value === 0 ? 1 : 0);
        return;
      }
      if (key.return) {
        if (overlay === 'help' || overlayFocus === 0) setOverlay(undefined);
        else if (overlay === 'discard') {
          setOverlay(undefined);
          setDirty(false);
          setDraftUpdates({});
          setDraftRemoves([]);
          const discardedSourceDraft = sourceDraft;
          setSourceDraft(undefined);
          if (discardForExit) {
            requestExit({ code: 0, reason: 'user' });
          } else if (discardedSourceDraft) {
            props.controller.discardSourceDraft(
              discardedSourceDraft.owner,
              discardedSourceDraft.mode === 'update'
                ? { name: 'sourceDetail', sourceId: discardedSourceDraft.sourceId }
                : { name: 'sourceList' },
            );
          } else {
            back();
          }
        } else requestExit({ code: snapshot.phase === 'error' ? 1 : 0, reason: snapshot.phase === 'error' ? 'initialError' : 'user' });
      }
      return;
    }
    if (key.ctrl && input.toLowerCase() === 'c') {
      requestExit({ code: snapshot.phase === 'error' ? 1 : 0, reason: snapshot.phase === 'error' ? 'initialError' : 'user' });
      return;
    }
    if (route.name === 'portableAgentInput') {
      if (key.escape) {
        back();
        return;
      }
      if (key.return) {
        try {
          const normalizedInput = portableAgentInput.trim();
          const agents = normalizePortableAgents(normalizedInput ? normalizedInput.split(/[\s,]+/u) : []);
          props.controller.setPortableAgentMode('explicit', agents);
          setInputError(undefined);
          go({ name: 'portableScope', pluginId: route.pluginId });
        } catch (error) {
          setInputError(error instanceof Error ? error.message.replace(/^portableInvalidAgentSelection:\s*/u, '') : 'Agent ID 无效。');
        }
        return;
      }
      if (key.backspace || key.delete) setPortableAgentInput(removeLastGrapheme);
      else if (input && !key.ctrl && !key.meta && input >= ' ') setPortableAgentInput((value) => value + input);
      setInputError(undefined);
      return;
    }
    if (route.name === 'sourceAdd'
      && route.step !== 'type'
      && route.step !== 'refPolicy'
      && sourceDraft?.owner === route.owner) {
      if (key.escape) {
        setOverlayFocus(0);
        setDiscardForExit(false);
        setOverlay('discard');
        return;
      }
      if (key.return) {
        let error: string | undefined;
        if (route.step === 'id') {
          if (!CATALOG_SOURCE_ID_PATTERN.test(sourceInput)) error = '格式必须是小写字母、数字或连字符，最多 32 字符。';
          else if (props.controller.listSources().some((source) => source.id === sourceInput)) error = '这个来源 ID 已存在。';
        } else if (route.step === 'location') {
          if (sourceDraft.type === 'path') {
            if (!path.isAbsolute(sourceInput)) error = '必须输入绝对路径。';
          } else {
            try { canonicalizeCatalogGitUrl(sourceInput); } catch { error = 'Git URL 不符合来源规范，或包含不允许的认证信息。'; }
          }
        } else if (route.step === 'ref') {
          if (sourceInput.trim() === '' || sourceInput !== sourceInput.trim() || /[\s\u0000-\u001f\u007f]/u.test(sourceInput)) error = '必须输入不含空白或控制字符的 Git ref。';
        } else if (sourceInput !== '') {
          const normalized = path.posix.normalize(sourceInput);
          if (sourceInput.includes('\\') || path.posix.isAbsolute(sourceInput)
            || normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
            error = '必须输入来源内部的相对 POSIX 路径。';
          }
        }
        if (error) {
          setSourceInputError(error);
          return;
        }
        const next = { ...sourceDraft };
        if (route.step === 'id') next.sourceId = sourceInput;
        else if (route.step === 'location') next.location = sourceInput;
        else if (route.step === 'ref') next.ref = sourceInput;
        else next.subdir = sourceInput === '' ? '' : path.posix.normalize(sourceInput).replace(/^\.\//u, '').replace(/\/$/u, '');
        setSourceDraft(next);
        setSourceInputError(undefined);
        if (route.step === 'id') go({ name: 'sourceAdd', step: 'location', owner: route.owner });
        else if (route.step === 'location') {
          if (next.mode === 'update') void beginSourceUpdateReview(next).catch(() => setActionError('来源修改未通过验证。'));
          else if (next.type === 'git') go({ name: 'sourceAdd', step: 'refPolicy', owner: route.owner });
          else void beginSourceAddReviewWith(next).catch(() => setActionError('来源未通过验证。请检查输入后重试。'));
        } else if (route.step === 'ref') {
          if (next.mode === 'update') void beginSourceUpdateReview(next).catch(() => setActionError('来源修改未通过验证。'));
          else go({ name: 'sourceAdd', step: 'subdir', owner: route.owner });
        } else if (next.mode === 'update') void beginSourceUpdateReview(next).catch(() => setActionError('来源修改未通过验证。'));
        else void beginSourceAddReviewWith(next).catch(() => setActionError('来源未通过验证。请检查输入后重试。'));
        return;
      }
      if (key.backspace || key.delete) setSourceInput(removeLastGrapheme);
      else if (input && !key.ctrl && !key.meta && input >= ' ') setSourceInput((value) => value + input);
      setSourceInputError(undefined);
      return;
    }
    if (route.name === 'configFieldEditor'
      && route.editor !== 'enum'
      && route.editor !== 'boolean') {
      if (key.escape) {
        back();
        return;
      }
      if (input === '\u0015' || (input.toLowerCase() === 'u' && key.ctrl)) {
        removeDraft(route.fieldKey);
        back();
        return;
      }
      if (key.return && activeField) {
        if (route.editor === 'sensitive' && inputValue.length === 0) {
          back();
          return;
        }
        if (route.editor === 'number') {
          const number = Number(inputValue);
          if (!Number.isFinite(number)) {
            setInputError('必须输入有限数字。');
            return;
          }
          if (activeField.min !== undefined && number < activeField.min
            || activeField.max !== undefined && number > activeField.max) {
            setInputError(`必须在 ${activeField.min ?? '不限'}–${activeField.max ?? '不限'} 范围内。`);
            return;
          }
          updateDraft(activeField.key, number);
        } else updateDraft(activeField.key, inputValue);
        back();
        return;
      }
      if (key.backspace || key.delete) setInputValue(removeLastGrapheme);
      else if (input && !key.ctrl && !key.meta && input >= ' ') setInputValue((value) => value + input);
      setInputError(undefined);
      return;
    }
    if (searchFocus && route.name === 'pluginList') {
      if (key.escape) {
        setSearchFocus(false);
        return;
      }
      if (key.return) {
        setSearchFocus(false);
        const row = pluginRows[focus];
        if (row) go(route.mode === 'browse'
          ? { name: 'pluginPreview', pluginId: row.pluginId }
          : { name: 'pluginDetail', pluginId: row.pluginId });
        return;
      }
      if (key.upArrow || key.downArrow) {
        setSearchFocus(false);
        setFocus((value) => moveIndex(pluginRows.length, value, key.upArrow ? -1 : 1));
        return;
      }
      if (key.leftArrow || key.rightArrow) {
        setSearchFocus(false);
        const tabs = ['all', ...props.controller.listSources().map((source) => source.id)];
        const current = route.sourceId ?? 'all';
        const direction = key.leftArrow ? -1 : 1;
        const next = tabs[(tabs.indexOf(current) + direction + tabs.length) % tabs.length]!;
        props.controller.replace(
          { name: 'pluginList', mode: route.mode, ...(next !== 'all' ? { sourceId: next } : {}) },
          { ...snapshot.router.current.context, query, installFilter, sourceTabId: next },
        );
        setFocus(0);
        setScrollOffset(0);
        return;
      }
      if (key.backspace || key.delete) setQuery(removeLastGrapheme);
      else if (input && !key.ctrl && !key.meta && input >= ' ') setQuery((value) => value + input);
      setFocus(0);
      setScrollOffset(0);
      return;
    }
    if (key.tab && (route.name === 'configLayer'
      || route.name === 'configFields'
      || route.name === 'configFieldEditor')) {
      return;
    }
    if (canOpenHelp && input === '?') {
      setOverlayFocus(0);
      setOverlay('help');
    } else if (input.toLowerCase() === 'q') {
      setOverlayFocus(0);
      setDiscardForExit(dirty);
      setOverlay(dirty ? 'discard' : 'exit');
    } else if (input.toLowerCase() === 'd' && supportsTechnicalDetails) {
      setShowTechnical((value) => !value);
    } else if ((key.escape || input.toLowerCase() === 'b')
      && (route.name === 'configFieldEditor' || route.name === 'configFieldAction')) {
      back();
    } else if (key.escape || input.toLowerCase() === 'b') {
      if (dirty) {
        setOverlayFocus(0);
        setDiscardForExit(false);
        setOverlay('discard');
      } else back();
    } else if (route.name === 'pluginList' && input === '/') {
      setSearchFocus(true);
    } else if (route.name === 'pluginList' && route.mode === 'browse' && input.toLowerCase() === 'f') {
      const selectedPluginId = pluginRows[focus]?.pluginId;
      const nextFilter = installFilter === 'all' ? 'uninstalled' : 'all';
      const nextItems = props.controller.listPlugins({
        mode: route.mode,
        ...(route.sourceId ? { sourceId: route.sourceId } : {}),
        ...(query ? { query } : {}),
        installFilter: nextFilter,
      });
      const retained = selectedPluginId
        ? nextItems.findIndex((item) => item.pluginId === selectedPluginId)
        : -1;
      setInstallFilter(nextFilter);
      props.controller.updatePageContext({ installFilter: nextFilter });
      setFocus(retained >= 0 ? retained : 0);
      setScrollOffset(0);
    } else if (route.name === 'configFields' && route.layer.scope !== 'effective' && input.toLowerCase() === 's') {
      if (dirty) void beginConfigSave();
    } else if (route.name === 'configFields' && route.layer.scope !== 'effective' && input.toLowerCase() === 'u') {
      const key = actions[focus]?.configKey;
      if (key) removeDraft(key);
    } else if (route.name === 'configFields' && visibleConfigTabs.length > 1
      && (key.leftArrow || key.rightArrow)) {
      const current = Math.max(0, visibleConfigTabs.findIndex((tab) => tab.id === activeConfigTabId));
      const direction = key.leftArrow ? -1 : 1;
      const next = visibleConfigTabs[(current + direction + visibleConfigTabs.length) % visibleConfigTabs.length]!;
      props.controller.updatePageContext({ configGroupId: next.id, focusIndex: 0, scrollOffset: 0 });
      setFocus(0);
      setScrollOffset(0);
    } else if (input.toLowerCase() === 'r' && route.name === 'sourceDetail') {
      void props.controller.reloadCatalog({ sourceId: route.sourceId });
    } else if (input.toLowerCase() === 'r' && route.name === 'sourceList') {
      const source = props.controller.listSources()[focus];
      if (source) {
        void props.controller.reloadCatalog({ sourceId: source.id });
      }
    } else if (route.name === 'pluginList' && (key.leftArrow || key.rightArrow || input === '[' || input === ']')) {
      const tabs = ['all', ...props.controller.listSources().map((source) => source.id)];
      const current = route.sourceId ?? 'all';
      const selectedPluginId = props.controller.listPlugins({
        mode: route.mode,
        ...(current !== 'all' ? { sourceId: current } : {}),
        ...(query ? { query } : {}),
        installFilter,
      })[focus]?.pluginId;
      const direction = key.leftArrow || input === '[' ? -1 : 1;
      const index = tabs.indexOf(current);
      const next = tabs[(index + direction + tabs.length) % tabs.length]!;
      const nextItems = props.controller.listPlugins({ mode: route.mode, ...(next !== 'all' ? { sourceId: next } : {}), ...(query ? { query } : {}), installFilter });
      const retained = selectedPluginId ? nextItems.findIndex((item) => item.pluginId === selectedPluginId) : -1;
      props.controller.replace(
        { name: 'pluginList', mode: route.mode, ...(next !== 'all' ? { sourceId: next } : {}) },
        { ...snapshot.router.current.context, query, installFilter, sourceTabId: next },
      );
      setFocus(retained >= 0 ? retained : 0);
      setScrollOffset(retained >= 4 ? retained - 3 : 0);
    } else if (input.toLowerCase() === 'a' && route.name === 'portableSkillSelect') {
      props.controller.selectAllPortableSkills();
    } else if (input === ' ' && route.name === 'portableSkillSelect') {
      const candidate = snapshot.portableDraft?.candidates[focus];
      if (candidate) props.controller.togglePortableSkill(candidate.name);
    } else if (key.upArrow || input.toLowerCase() === 'k') {
      setFocus((value) => {
        const current = dynamicActionIds ? effectiveFocus : value;
        const next = pluginRows.length > 0 ? moveIndex(pluginRows.length, current, -1) : moveFocus(actions, current, -1);
        if (dynamicActionIds && dynamicActionSignature !== undefined) {
          dynamicMenuFocus.current = {
            routeKey,
            actionIds: dynamicActionSignature,
            focusedActionId: dynamicActionIds[next],
          };
        }
        const viewport = route.name === 'portableSkillSelect' && snapshot.portableDraft
          ? portableSkillCandidateViewport(
              actions.slice(0, snapshot.portableDraft.candidates.length),
              snapshot.portableDraft.candidates,
              policy.mode === 'compact',
              next,
              scrollOffset,
              pageActionBudget(
                actions.length - snapshot.portableDraft.candidates.length
                + (portableVariantCandidates.length > 0 ? 3 : 0),
              ),
            )
          : actionViewport(
              actions,
              policy.mode === 'compact',
              next,
              scrollOffset,
              pageActionBudget(route.name === 'dependencyPlacement' ? dependencyPlacementStaticRows : 0),
            );
        setScrollOffset(viewport.offset);
        return next;
      });
    } else if (key.downArrow || input.toLowerCase() === 'j') {
      setFocus((value) => {
        const current = dynamicActionIds ? effectiveFocus : value;
        const next = pluginRows.length > 0 ? moveIndex(pluginRows.length, current, 1) : moveFocus(actions, current, 1);
        if (dynamicActionIds && dynamicActionSignature !== undefined) {
          dynamicMenuFocus.current = {
            routeKey,
            actionIds: dynamicActionSignature,
            focusedActionId: dynamicActionIds[next],
          };
        }
        const viewport = route.name === 'portableSkillSelect' && snapshot.portableDraft
          ? portableSkillCandidateViewport(
              actions.slice(0, snapshot.portableDraft.candidates.length),
              snapshot.portableDraft.candidates,
              policy.mode === 'compact',
              next,
              scrollOffset,
              pageActionBudget(
                actions.length - snapshot.portableDraft.candidates.length
                + (portableVariantCandidates.length > 0 ? 3 : 0),
              ),
            )
          : actionViewport(
              actions,
              policy.mode === 'compact',
              next,
              scrollOffset,
              pageActionBudget(route.name === 'dependencyPlacement' ? dependencyPlacementStaticRows : 0),
            );
        setScrollOffset(viewport.offset);
        return next;
      });
    } else if (key.return && route.name === 'pluginList' && pluginRows[focus]) {
      go(route.mode === 'browse'
        ? { name: 'pluginPreview', pluginId: pluginRows[focus]!.pluginId }
        : { name: 'pluginDetail', pluginId: pluginRows[focus]!.pluginId });
    } else if (key.return) {
      runAction(actions[effectiveFocus]);
    }
  });

  if (tooSmall) {
    return (
      <ScreenFrame title="终端空间不足" breadcrumb="终端空间不足" context={`${size.columns} × ${size.rows}`} help="q 退出" size={size}>
        <Callout status="warning" title="↔ 请将终端调整到至少 60 × 18" description="调整后会返回原页面，不会丢失当前选择。" />
      </ScreenFrame>
    );
  }

  if (actionError) description = actionError;
  const base = (
    <ScreenFrame title={title} description={description} breadcrumb={breadcrumb} context={context} help={help} size={size}>
      {content}
    </ScreenFrame>
  );
  if (!overlay) return base;
  const helpRows = helpRowsForRoute(route, actions.length, supportsTechnicalDetails, busy);
  const overlayActions: ActionItem[] = overlay === 'help'
    ? [{ label: '关闭' }]
    : [
        { label: overlay === 'discard' ? '继续编辑' : '继续使用' },
        { label: overlay === 'discard' ? '放弃修改' : '退出', status: 'error' },
      ];
  return (
    <Box position="relative" width={size.columns} height={size.rows}>
      <Box>{overlay === 'help' ? null : base}</Box>
      <Box position="absolute" marginTop={5} marginLeft={Math.max(2, Math.floor(size.columns / 5))} width={Math.max(40, Math.floor(size.columns * 0.6))} flexDirection="column">
        <ReviewCard title={overlay === 'help' ? '当前页快捷键' : overlay === 'discard' ? '放弃未保存修改？' : '退出控制台？'}>
        {overlay === 'help'
          ? <>{helpRows.map(([key, value]) => <StaticRow key={key} title={`${key}  ${value}`} compact />)}</>
          : <StaticRow title={overlay === 'discard' ? '放弃后将返回上一页。' : '进行中的写操作会先完成。'} status="muted" />}
        <SemanticRows actions={overlayActions} focus={overlayFocus} kind="action" compact />
        </ReviewCard>
      </Box>
    </Box>
  );
}
