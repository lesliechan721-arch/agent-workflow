import { Box, Text, useInput, useWindowSize } from 'ink';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import path from 'node:path';
import stringWidth from 'string-width';
import {
  validatePluginConfigValue,
} from '@lesliechan721/aw-plugin-core/manifest';

import type {
  CatalogSource,
  PlatformName,
  PluginConfigAdditionalPropertiesField,
  PluginConfigObject,
  PluginConfigObjectPropertyField,
  PluginConfigScalar,
  PluginConfigValue,
  Scope,
} from '../types.js';
import {
  CATALOG_BETA_REF,
  CATALOG_LATEST_REF,
  OFFICIAL_CATALOG_SOURCE_SSH_URL,
  OFFICIAL_CATALOG_SOURCE_URL,
} from '../constants.js';
import { CATALOG_SOURCE_ID_PATTERN } from '../utils/catalog-sources.js';
import { canonicalizeCatalogGitUrl } from '../utils/catalog-source-identity.js';
import {
  normalizePortableAgents,
  SKILLS_CLI_SUPPORTED_VERSION_LABEL,
} from '../portable/commands.js';
import {
  selectLifecycleRetryAction,
} from '../commands/operation-planner.js';
import type { CatalogStoreStatusResult } from '../commands/catalog-store.js';
import {
  parseScriptTimeoutMs,
  SCRIPT_TIMEOUT_DEFAULT_MS,
  SCRIPT_TIMEOUT_MAX_MS,
  SCRIPT_TIMEOUT_MIN_MS,
} from '../commands/options.js';
import { projectCatalogSourceLocation } from '../utils/catalog-source-presentation.js';
import {
  ActionRow,
  ObjectCardRow,
  objectCardRowLayout,
  StatusBadge,
  diagnosticDetailLines,
  Callout,
  ChoiceRow,
  ContentViewport,
  diagnosticDetailRowCount,
  DiagnosticSummary,
  InputCard,
  PluginListRow,
  PinnedActionBar,
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
  BatchPluginWriteAction,
  ExternalDraftState,
  OperationIntent,
  OperationReviewChange,
  OperationReviewModel,
  OperationResultSummary,
  PluginWriteBatchTarget,
  PluginWriteTaskCandidate,
  PluginWriteTaskGoal,
  TuiController,
  TuiControllerSnapshot,
} from './controller.js';
import {
  extractPortableError,
  TuiConfigInvalidStoreError,
  userIssueKey,
} from './controller.js';
import type { CatalogSourceGenerationViewModel } from './catalog-generation.js';
import type { SessionNavigation, SessionNavigationResult } from './session-host.js';
import type { CatalogSourceFreshnessViewModel } from './catalog-freshness.js';
import { pluginWriteTaskVersionEvidence } from './plugin-write-task.js';
import {
  catalogSourceFreshnessLabel,
  catalogSourceListPresentation,
} from './catalog-sources/screens.js';
import {
  operationDiagnosticLineCount,
  operationHistoryMeta,
  operationHistoryState,
  operationReportLineCount,
  OperationDiagnosticScreen,
  OperationReportPreviewScreen,
} from './operation-diagnostic-screens.js';
import { resolveTuiSizePolicy } from './layout.js';
import {
  buildDependencyGraphProjection,
  buildUnifiedDependencyGraphProjection,
  type DependencyGraphRow,
} from './dependency-graph.js';
import { platformLabel, scopeLabel } from './glossary.js';
import { InputDisplay, removeLastGrapheme } from './input-display.js';
import { catalogRefPolicyForPreset } from './source-ref-presets.js';
import type {
  ConfigFieldViewModel,
  ConfigPageViewModel,
  DependencyPlacementReferenceViewModel,
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
  configObjectHasSensitiveChild,
  hasInstalledPlacement,
  configValuesEqual,
} from './model.js';
import type { PluginInstallFilter, TuiRoute } from './router.js';
import { resolveTuiGlobalKeyAction, resolveTuiSessionNavigationKey } from './keys.js';
import { tuiTheme } from './theme.js';
import { contentRowBudget, rowViewport, type RowViewport } from './viewport.js';
import {
  resolveRouteScreenId,
  routeDefinition,
  TUI_SCREEN_IDS,
  type TuiScreenId,
  unreachableTuiRoute,
} from './screen-registry.js';

export const CONSOLE_V4_SCREEN_IDS = TUI_SCREEN_IDS;
export type ConsoleV4ScreenId = TuiScreenId;
type Overlay = 'help' | 'exit' | 'discard' | 'sessionNavigation' | undefined;
type PluginListChooser = { kind: 'source' | 'status'; focus: number } | undefined;

const PLUGIN_FILTERS: PluginInstallFilter[] = [
  'all', 'installed', 'uninstalled', 'updateAvailable', 'attention',
];

function pluginFilterLabel(filter: PluginInstallFilter): string {
  return {
    all: '全部',
    installed: '已安装',
    uninstalled: '未安装',
    updateAvailable: '可更新',
    attention: '需处理',
  }[filter];
}

interface ActionItem {
  actionId?: string;
  label: string;
  description?: string;
  meta?: string;
  status?: 'success' | 'warning' | 'error' | 'info' | 'muted';
  disabled?: string;
  run?: () => void | Promise<void>;
  configKey?: string;
  selected?: boolean;
  pluginId?: string;
  canSelectNew?: boolean;
  tags?: ReactNode;
}

function paginationActions(options: {
  offset: number;
  total: number;
  pageRows: number;
  move: (direction: -1 | 1) => void;
}): ActionItem[] {
  return [
    {
      actionId: 'pagination-previous',
      label: 'p 上一页',
      disabled: options.offset <= 0 ? '已在第一页' : undefined,
      run: () => options.move(-1),
    },
    {
      actionId: 'pagination-next',
      label: 'n 下一页',
      disabled: options.offset + options.pageRows >= options.total ? '已在最后一页' : undefined,
      run: () => options.move(1),
    },
  ];
}

interface OperationConfirmationOverlay {
  reviewToken: string;
  returnFocus: number;
  returnScrollOffset: number;
  warningOffset: number;
}

interface SourceTransportOverlay {
  owner: string;
}

interface DynamicMenuFocus {
  routeKey: string;
  actionIds: string;
  focusedActionId?: string;
}

interface ConfigDraftIssue {
  scope: Scope;
  key: string;
  source: 'update' | 'remove' | 'object';
}

interface ConfigLayerDraft {
  updates: Record<string, PluginConfigValue>;
  removes: string[];
}

interface ConfigCandidate {
  pluginId: string;
  flowId?: string;
  overviewFrameId?: string;
  groupId?: string;
  fieldKey?: string;
  presetId?: string;
  mutations: Record<string, { kind: 'set'; value: PluginConfigValue } | { kind: 'unset' }>;
}

type SourceOperationBlockReason = NonNullable<ReturnType<TuiController['catalogSourceRecoveryBlockReason']>>;

function sourceOperationBlockLabel(reason: SourceOperationBlockReason): string {
  switch (reason) {
    case 'configDraft': return '未保存的插件设置';
    case 'sourceDraft': return '未保存的来源修改';
    case 'batchDraft': return '未完成的批量操作选择';
    case 'portableDraft': return '未完成的通用 Skills 选择';
    case 'activeReview': return '等待确认的操作';
    case 'reviewPreparation': return '正在准备确认信息的操作';
    case 'writeProgress': return '正在执行的写入操作';
  }
}

function productResultMessage(message: string): string {
  if (message === '后续：当前项目 sync') return '后续：同步当前项目位置';
  if (message === '后续：所有项目 sync') return '后续：同步所有项目位置';
  return message;
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
  attention?: string;
  placementSummary: string;
  tags?: ReactNode;
  statusLabel: string;
  status: 'success' | 'warning' | 'error' | 'info' | 'muted';
  menuAction?: () => void;
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
  autoCheck: boolean;
}

interface BatchDraft {
  flowId: string;
  action?: BatchPluginWriteAction;
  recommendedGoal?: 'update';
  mode: 'browse' | 'installed';
  stage: 'select' | 'task' | 'maintenance';
  selection: 'selected' | 'currentProjectIntentRoots';
  selectedPluginIds: string[];
  frozenPluginIds?: string[];
  platform: PlatformName | 'both';
  scope: Scope;
  sourceId?: string;
  query: string;
  installFilter: PluginInstallFilter;
  showSelected: boolean;
  showSelectionTools?: boolean;
  showPlacementTargets?: boolean;
  maintenanceTargets?: PluginWriteBatchTarget[];
  selectedMaintenanceTargetKeys?: string[];
  maintenanceGoal?: PluginWriteTaskGoal;
  stageView?: Partial<Record<BatchDraft['stage'], { focusIndex: number; scrollOffset: number }>>;
}

function batchTargetKey(target: PluginWriteBatchTarget): string {
  return [target.pluginId, target.platform, target.scope].join('\0');
}

function batchPluginVersionSummary(plugin: PluginListItemViewModel): string {
  const updates = plugin.update.targets.filter((target) => target.availableVersion !== undefined);
  if (updates.length === 0) return plugin.version ? `版本 ${plugin.version}` : '版本待确认';
  const changes = [...new Set(updates.map((target) =>
    `${target.installedVersion ?? '待确认'} → ${target.availableVersion}`))];
  return changes.length === 1
    ? changes[0]!
    : `${updates.length} 个位置版本不同（Enter 查看）`;
}

function scopedPluginPlacementConclusion(placement: Extract<PlatformPlacementSummary, { state: 'installed' }>, location: string): {
  text: string;
  status: 'success' | 'warning' | 'error' | 'muted';
} {
  if (placement.blockingReason === 'artifactCollision' || placement.actualState === 'blocked') {
    return { text: `${location}暂时不可用`, status: 'error' };
  }
  if (placement.actualState === 'needsSync' || placement.health === 'incomplete') {
    return { text: `${location}需要同步`, status: 'warning' };
  }
  if (placement.health === 'error') return { text: `${location}状态未知`, status: 'warning' };
  return { text: `${location}可用`, status: 'success' };
}

function pluginPlacementConclusions(placement: PlatformPlacementSummary): Array<{
  text: string;
  status: 'success' | 'warning' | 'error' | 'muted';
}> {
  if (placement.state === 'notInstalled') return [{ text: '未添加', status: 'muted' }];
  if (placement.state === 'blocked') return [{ text: '无法添加：输出位置有冲突', status: 'error' }];
  if (placement.state === 'scopeConflict') return [{ text: '使用位置冲突，需要选择一个位置', status: 'warning' }];
  if (!placement.scopedPlacements?.length) {
    const location = placement.desiredScopes?.map(scopeLabel).join('、') || scopeLabel(placement.scope);
    return [scopedPluginPlacementConclusion(placement, location)];
  }
  const grouped = new Map<string, {
    scopes: Scope[];
    status: 'success' | 'warning' | 'error' | 'muted';
    suffix: string;
  }>();
  for (const scoped of placement.scopedPlacements) {
    const conclusion = scopedPluginPlacementConclusion({
      platform: placement.platform,
      state: 'installed',
      scope: scoped.scope,
      health: scoped.health,
      revision: scoped.revision,
      desiredScopes: [scoped.scope],
      ...(scoped.actualState ? { actualState: scoped.actualState } : {}),
      ...(scoped.recovery ? { recovery: scoped.recovery } : {}),
      ...(scoped.blockingReason ? { blockingReason: scoped.blockingReason } : {}),
    }, '');
    const key = `${conclusion.status}\0${conclusion.text}`;
    const current = grouped.get(key);
    if (current) current.scopes.push(scoped.scope);
    else grouped.set(key, { scopes: [scoped.scope], status: conclusion.status, suffix: conclusion.text });
  }
  return [...grouped.values()].map((entry) => ({
    text: `${entry.scopes.map(scopeLabel).join('、')}${entry.suffix}`,
    status: entry.status,
  }));
}

interface BatchSelectionCandidate {
  pluginId: string;
  plugin?: PluginListItemViewModel;
}

interface DependencyGraphSessionContext {
  expandedPluginIds: Set<string>;
  focusedActionId?: string;
  scrollAnchorActionId?: string;
}

function isCharacterInputMode(route: TuiRoute, searchMode: boolean): boolean {
  if (routeDefinition(route).keymap !== 'menuOrTextInput') return false;
  return searchMode
    || route.name === 'portableAgentInput'
    || route.name === 'configFieldEditor'
      && (route.editor === 'string' || route.editor === 'number')
      && route.mode !== 'choices'
    || route.name === 'configObjectPropertyEditor'
      && (route.stage === 'key' || route.stage === 'custom')
    || route.name === 'sourceAdd' && route.step !== 'type' && route.step !== 'refPolicy'
    || route.name === 'scriptTimeout';
}

function supportsScriptTimeout(
  intent: OperationIntent | undefined,
): intent is OperationIntent & { scriptTimeoutMs?: number } {
  return intent?.kind === 'pluginWrite'
    && (intent.action === 'install' || intent.action === 'sync'
      || intent.action === 'refreshAndSync' || intent.action === 'reinstall')
    || intent?.kind === 'pluginWriteBatch'
      && (intent.action === 'install' || intent.action === 'sync' || intent.action === 'reinstall')
    || intent?.kind === 'pluginWriteTask'
    || (intent?.kind === 'configSave' || intent?.kind === 'configSaveBatch') && intent.apply;
}

function helpRowsForRoute(
  route: TuiRoute,
  actionCount: number,
  supportsTechnicalDetails: boolean,
  busy: boolean,
  sessionNavigation: boolean,
): HelpRow[] {
  const rows: HelpRow[] = [];
  if (!busy && actionCount > 1) rows.push(['↑/↓ · j/k', '移动当前唯一焦点']);
  if (!busy && actionCount > 0) rows.push(['Enter', '打开、选择或继续']);
  if (!busy && route.name !== 'home') rows.push(['Esc / b', '返回上一页']);
  if (route.name === 'pluginList') {
    rows.push(['←/→ · [ / ]', '切换来源']);
    rows.push(['/', '进入搜索']);
    if (route.name === 'pluginList') rows.push(['f', '切换插件状态']);
  }
  if (route.name === 'portableSkillSelect') {
    rows.push(['Space', '切换当前 Skill']);
    rows.push(['a', '全选 Skills']);
  }
  if (route.name === 'batchSelection') {
    rows.push(['Space', '切换当前插件']);
    rows.push(['a', '全选当前筛选结果']);
    rows.push(['c', '继续选择位置和平台']);
  }
  if (route.name === 'configFields' && route.layer.scope !== 'effective') {
    rows.push(['s', '查看保存汇总']);
    rows.push(['u', '恢复当前字段继承']);
  }
  if (route.name === 'sourceList' || route.name === 'sourceDetail' || route.name === 'sourceMore') {
    rows.push(['r', '检查来源']);
  }
  if (supportsTechnicalDetails) {
    rows.push(['d', route.name === 'progress' ? '打开技术进度' : '打开技术详情']);
  }
  if (sessionNavigation && !busy && !isCharacterInputMode(route, false)) {
    rows.push(['h / H', '返回首页 / 重新读取本地状态']);
  }
  if (sessionNavigation && busy) {
    rows.push(['h / H', '操作成功后返回首页或重新读取']);
    rows.push(['Esc', '撤销等待中的页面跳转']);
  }
  if (route.name === 'pluginList' || route.name === 'pluginDetail'
    || route.name === 'batchSelection' || route.name === 'installTargets') {
    rows.push(['状态', '✓已装 ○未装 !异常 ↑更新 ?未知']);
  }
  rows.push(['q / Ctrl-C', busy ? '操作完成后退出' : '退出控制台']);
  rows.push(['? / o', '关闭帮助 / 查看操作记录']);
  return rows;
}

function configOwnerKey(route: Extract<TuiRoute, {
  name: 'configFields' | 'configFieldEditor' | 'configObjectPropertyEditor' | 'configFieldAction' | 'configSave';
}>): string {
  return route.pluginId;
}

function configPageMatches(
  page: ConfigPageViewModel | undefined,
  route: Extract<TuiRoute, { name: 'configFields' | 'configFieldEditor' | 'configObjectPropertyEditor' | 'configFieldAction' | 'configSave' }> | undefined,
): page is ConfigPageViewModel {
  return Boolean(page && route
    && page.pluginId === route.pluginId
    && page.layer.scope === route.layer.scope);
}

function configFieldCanSet(field: ConfigFieldViewModel): boolean {
  return field.canSet ?? field.writable;
}

function configFieldCanUnset(field: ConfigFieldViewModel): boolean {
  return field.canUnset ?? (field.writable && field.configured);
}

function batchActionLabel(action: BatchPluginWriteAction): string {
  return {
    install: '添加',
    sync: '同步',
    reinstall: '重新安装',
    uninstall: '卸载',
    cleanup: '清理',
  }[action];
}

function pluginWriteTaskLabel(goal: PluginWriteTaskGoal): string {
  return goal === 'update' ? '更新' : '恢复';
}

function pluginWriteTaskBlockLabel(reason: PluginWriteTaskCandidate['blockReason']): string {
  return {
    catalogActivationRequired: '需要先更新并启用来源目录',
    updateEvidenceIncomplete: '更新版本证据不完整',
    updateIncompatible: '候选版本与当前 AW 不兼容',
    restoreVersionChanged: '恢复会改变版本，需要单独决定',
    restoreVersionUnverified: '当前安装版本无法验证',
    manualRecoveryRequired: '需要选择手动处理方式',
    taskActionConflict: '同一根因需要不同处理方式',
    targetUnavailable: '这个安装位置已不可用',
  }[reason ?? 'targetUnavailable'];
}

function pluginWriteTaskMethodLabel(method: PluginWriteTaskCandidate['recommendedMethod']): string {
  return method === 'reinstall' ? '重新生成缺失内容' : '同步当前使用位置';
}

function pluginWriteTaskTargetKey(candidate: PluginWriteTaskCandidate): string {
  const { pluginId, platform, scope } = candidate.target;
  return [pluginId, platform, scope].join('\0');
}

function dependencyGraphContextKey(
  pluginId: string,
  direction: 'dependencies' | 'dependents',
): string {
  return `${pluginId}\0${direction}`;
}

function unifiedDependencyGraphActionIds(
  projection: ReturnType<typeof buildUnifiedDependencyGraphProjection>,
): string[] {
  return [
    ...projection.rows.map((row) => `row:${row.branch}:${row.id}`),
    ...projection.dependents.scopeSummary.unknownConsumerPluginIds
      .map((pluginId) => `unverified:${pluginId}`),
    'technical',
  ];
}

function statusText(plugin: PluginListItemViewModel): string {
  if (plugin.configOnly) return '已保存设置';
  const updateTargets = (plugin.update?.targets ?? []).filter((target) => target.availableVersion !== undefined);
  if (updateTargets.length === 1) {
    const target = updateTargets[0]!;
    return `可更新 ${target.installedVersion ?? '待确认'} → ${target.availableVersion}${target.requiresCatalogActivation ? '（需先更新来源）' : ''}`;
  }
  if (updateTargets.length > 1) return `${updateTargets.length} 个位置可更新`;
  const incompatibleCandidate = plugin.update?.targets.find((target) =>
    target.candidateVersion !== undefined && (target.missingCapabilities?.length ?? 0) > 0);
  if (incompatibleCandidate) return `新版 ${incompatibleCandidate.candidateVersion} 暂不可用`;
  return {
    available: '未添加',
    installed: '可用',
    needsAttention: '需要处理',
    unavailable: plugin.capabilityUnsupported && !plugin.sourceUnavailable
      ? '需要升级 AW CLI'
      : '来源不可用',
  }[plugin.aggregateStatus];
}

function pluginUpdateDescription(plugin: PluginListItemViewModel): string | undefined {
  const targets = (plugin.update?.targets ?? []).filter((target) => target.availableVersion !== undefined);
  if (targets.length === 0) {
    const incompatibleCandidate = plugin.update?.targets.find((target) =>
      target.candidateVersion !== undefined && (target.missingCapabilities?.length ?? 0) > 0);
    return incompatibleCandidate
      ? `候选版本缺少 ${incompatibleCandidate.missingCapabilities!.length} 项 AW 功能支持；当前启用版本可继续使用。`
      : undefined;
  }
  if (targets.some((target) => target.requiresCatalogActivation)) {
    return plugin.update?.lastSuccessful
      ? `上次成功检查：${plugin.update.checkedAt ? new Date(plugin.update.checkedAt).toLocaleString('zh-CN', { hour12: false }) : '时间未知'}；需先更新来源目录。`
      : '已验证待检查版本；需先更新来源目录。';
  }
  return '当前启用目录已验证；可直接进入更新确认。';
}

function pluginPlatformBadges(plugin: PluginListItemViewModel): React.JSX.Element {
  const items = plugin.supportedPlatforms.map((platform) => {
    const placements = plugin.installedPlacements.filter((entry) => entry.platform === platform);
    const installed = placements.some((entry) => entry.state === 'installed' || entry.state === 'scopeConflict');
    const unknown = plugin.sourceUnavailable || placements.length === 0
      || placements.some((entry) => entry.state === 'installed' && entry.sharedNative?.state === 'unobserved');
    const attention = placements.some((entry) => entry.state === 'blocked' || entry.state === 'scopeConflict'
      || entry.state === 'installed' && (entry.health !== 'ready' || entry.blockingReason !== undefined));
    const update = plugin.update.targets.some((target) => target.platform === platform
      && target.availableVersion !== undefined);
    return {
      key: platform,
      label: `${platformLabel(platform)}${attention && (installed || unknown) ? ' !' : ''}${update ? ' ↑' : ''}${unknown && installed ? ' ?' : ''}`,
      symbol: installed ? '✓' as const : unknown ? '?' as const : attention ? '!' as const : '○' as const,
      status: attention ? 'warning' as const : unknown ? 'muted' as const
        : update ? 'info' as const : installed ? 'success' as const : 'muted' as const,
    };
  });
  return <Box>
    <StatusBadge items={items} />
    {plugin.portableSkills ? <Text color={tuiTheme.colors.accent}> [Skills 可选]</Text> : null}
    {plugin.configOnly ? <Text color={tuiTheme.colors.muted}>[已保存设置]</Text> : null}
  </Box>;
}

function installedScopeStates(
  plugin: PluginListItemViewModel,
  platform: PlatformName,
): Map<Scope, { symbol: '✓' | '!'; status: 'success' | 'warning' | 'error' }> {
  const states = new Map<Scope, { symbol: '✓' | '!'; status: 'success' | 'warning' | 'error' }>();
  const placement = plugin.installedPlacements.find((entry) => entry.platform === platform);
  if (!placement || placement.state === 'notInstalled' || placement.state === 'blocked') return states;
  const scoped = placement.state === 'scopeConflict'
    ? placement.placements
    : placement.scopedPlacements ?? [{
        scope: placement.scope,
        health: placement.health,
        revision: placement.revision,
        actualState: placement.actualState,
      }];
  for (const entry of scoped) {
    const actualState = 'actualState' in entry ? entry.actualState : undefined;
    const healthy = entry.health === 'ready' && actualState !== 'blocked'
      && actualState !== 'needsSync';
    states.set(entry.scope, healthy
      ? { symbol: '✓', status: 'success' }
      : { symbol: '!', status: actualState === 'blocked' || entry.health === 'error'
          ? 'error' : 'warning' });
  }
  return states;
}

function issueMatchesTarget(
  issue: UserIssueViewModel,
  pluginId: string,
  platform?: PlatformName,
  scope?: Scope,
): boolean {
  if (!platform && !scope && issue.pluginId === pluginId) return true;
  const matches = [
    issue.rootEntity,
    ...(issue.affectedTargets ?? []),
    ...(issue.pluginId && issue.platform && issue.scope
      ? [{ pluginId: issue.pluginId, platform: issue.platform, scope: issue.scope }]
      : []),
  ].filter((target): target is { pluginId: string; platform: PlatformName; scope: Scope } =>
    target !== undefined && target.pluginId === pluginId);
  return matches.some((target) => (!platform || target.platform === platform)
    && (!scope || target.scope === scope));
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
  if (plugin.configOnly) return 'warning';
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

function dedupeActions(actions: ActionItem[]): ActionItem[] {
  const seen = new Set<string>();
  return actions.filter((action) => {
    const id = action.actionId ?? action.label;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function wrapConsoleText(value: string, columns: number): string[] {
  const width = Math.max(1, columns);
  const graphemes = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value)]
    .map((part) => part.segment);
  const lines: string[] = [];
  let line = '';
  let lineWidth = 0;
  for (const grapheme of graphemes) {
    const graphemeWidth = stringWidth(grapheme);
    if (line && lineWidth + graphemeWidth > width) {
      lines.push(line);
      line = '';
      lineWidth = 0;
    }
    line += grapheme;
    lineWidth += graphemeWidth;
  }
  if (line || lines.length === 0) lines.push(line);
  return lines;
}

function changeDetailLines(
  changes: ReadonlyArray<{ title: string; before?: string; after?: string }>,
  columns: number,
): string[] {
  const valueLines = (label: string, value: string | undefined): string[] => [
    label,
    ...wrapConsoleText(value ?? '未设置', Math.max(1, columns - 4)).map((line) => `  ${line}`),
  ];
  return changes.flatMap((change) => [
    `修改项 · ${change.title}`,
    ...valueLines('修改前', change.before),
    ...valueLines('修改后', change.after),
  ]);
}

function operationRiskWarnings(review: OperationReviewModel): string[] {
  return [...new Set([
    ...(review.sharedImpact.warning ? [review.sharedImpact.warning] : []),
    ...review.changes.filter((change) => change.kind === 'warning' || change.kind === 'remove')
      .map((change) => `${change.title}${change.description ? `：${change.description}` : ''}`),
    ...review.changes.filter((change) => change.group === 'preserved')
      .map((change) => `保留：${change.title}${change.description ? `：${change.description}` : ''}`),
  ])];
}

function operationRiskLines(review: OperationReviewModel, columns: number): string[] {
  const summaries = [
    `操作：${review.title} · ${review.subject.name}`,
    ...(review.confirmationDetails ?? []),
    ...operationRiskWarnings(review).map((warning) => `! ${warning}`),
  ];
  return summaries.flatMap((summary) => {
    const lines = wrapConsoleText(summary, Math.max(1, columns - 2));
    return lines.map((line, index) => index === 0 ? line : `  ${line}`);
  });
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

function objectCardActionViewport(
  actions: ActionItem[],
  width: number,
  compact: boolean,
  focus: number,
  requestedOffset: number,
  lineBudget: number,
): RowViewport {
  return rowViewport({
    rowHeights: actions.map((action) => objectCardRowLayout({
      width,
      description: action.disabled ?? action.description ?? '',
      meta: action.meta,
      hasTags: action.tags !== undefined,
      compact,
    }).height),
    focus,
    requestedOffset,
    rowBudget: lineBudget,
  });
}

function portableSkillCandidateViewport(
  actions: ActionItem[],
  width: number,
  compact: boolean,
  focus: number,
  requestedOffset: number,
  rowBudget: number,
): RowViewport {
  return objectCardActionViewport(actions, width, compact, focus, requestedOffset, rowBudget);
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

function sourceLocationSummary(type: 'git' | 'path', value: string | undefined): string {
  if (!value) return '不可用';
  if (type === 'path') return value;
  try {
    const url = new URL(value);
    const repository = url.pathname.split('/').filter(Boolean).at(-1);
    return repository ? `${url.hostname} / ${repository}` : url.hostname;
  } catch {
    return value.startsWith('ssh://') || value.includes('@') ? 'SSH 远程来源' : '远程来源';
  }
}

function portableBlockerDiagnostic(
  route: Extract<TuiRoute, { name: 'portableBlocker' }>,
): DiagnosticSummaryViewModel {
  const cliMissing = route.code === 'portableSkillsCliMissing';
  const cliIncompatible = route.code === 'portableSkillsCliIncompatible';
  const cliUnavailable = cliMissing || cliIncompatible;
  const sensitiveOutput = route.diagnosticCode === 'portableSensitiveOutput';
  const invalidRuntimeImport = route.diagnosticCode === 'portableRuntimeImportMissing';
  const skillCollision = route.diagnosticCode === 'portableSkillCollision';
  const distributionUnavailable = route.diagnosticCode === 'portableDistributionUnavailable';
  const userMessage = route.code === 'requiredConfigMissing'
    ? '插件缺少生成内容所需的设置。'
    : route.code === 'portableScopeUnavailable'
      ? '至少一个所选 Skill 不适用于这个范围。'
      : cliMissing
        ? '没有找到已安装的 Skills CLI。'
        : cliIncompatible
          ? `已安装 Skills CLI，但版本不在支持范围 ${SKILLS_CLI_SUPPORTED_VERSION_LABEL}。`
        : sensitiveOutput
          ? '生成的 Skill 内容包含敏感配置值或未解析模板。'
          : invalidRuntimeImport
            ? '所需运行时引用未解析、缺失或无效。'
            : skillCollision
              ? '两个来源提供同名 Skill，无法安全确定写入内容。'
              : distributionUnavailable
                ? '插件没有可信的通用 Skills 分发定义。'
        : '候选 Skill 没有通过 Portable 安全校验。';
  const blocked = route.code === 'requiredConfigMissing'
    ? '缺少生成 Skill 所需的设置；没有调用 Skills CLI。'
    : cliMissing
      ? 'Skills CLI 尚未安装；当前不能开始安装。'
      : cliIncompatible
        ? '已安装的 Skills CLI 版本不兼容；当前不能开始安装。'
      : route.code === 'portableScopeUnavailable'
        ? '所选内容不能在这个范围完整生成；没有开始写入。'
        : sensitiveOutput || invalidRuntimeImport || skillCollision || distributionUnavailable
          ? '没有开始写入，也没有调用 Skills CLI。'
        : '候选内容没有通过安全校验；没有开始写入。';
  const nextStep = route.code === 'requiredConfigMissing'
    ? '完成插件设置，然后重新准备。'
    : cliMissing
      ? '安装兼容的 Skills CLI，然后重新检查。'
      : cliIncompatible
        ? '升级或切换到兼容的 Skills CLI，然后重新检查。'
      : route.code === 'portableScopeUnavailable'
        ? '返回 Skill 选择或更改范围，然后重新检查。'
        : skillCollision
          ? '返回修改 Skills，移除同名冲突后重新检查。'
          : distributionUnavailable
            ? '修复插件的通用 Skills 分发定义，然后重新检查。'
            : '修复来源内容或修改选择，然后重新检查。';
  return {
    severity: 'error',
    title: route.code === 'portableScopeUnavailable' ? '所选范围不可用'
      : cliMissing ? '未安装 Skills CLI'
        : cliIncompatible ? 'Skills CLI 版本不兼容' : '无法准备通用 Skills',
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
        value: `Skills CLI ${SKILLS_CLI_SUPPORTED_VERSION_LABEL}`,
      }] } : {}),
      checks: cliUnavailable
        ? ['检查 PATH 中的 Skills CLI 版本。', '安装兼容版本后运行“重新检查”。']
        : ['检查插件设置、所选范围和 Portable 来源内容。', '修复后运行“重新检查”。'],
    },
  };
}

function configUnavailableCanRecoverSource(
  route: Extract<TuiRoute, { name: 'configUnavailable' }>,
): boolean {
  if (route.storedScopes?.length) return false;
  return new Set([
    'catalogSourceUnavailable',
    'bundleUnavailable',
    'sourceMissing',
    'catalogGenerationUnavailable',
    'catalogGenerationStateInvalid',
    'catalogGenerationStoreInvalid',
    'catalogStateInvalid',
    'catalogStoreInvalid',
    'configReadFailed',
  ]).has(route.diagnosticCode ?? '');
}

function configUnavailableDiagnostic(
  route: Extract<TuiRoute, { name: 'configUnavailable' }>,
): DiagnosticSummaryViewModel {
  const invalidLayer = (route.invalidStores?.length ?? 0) > 0;
  const invalidLayerLabel = route.invalidStores?.map((store) =>
    store.scope === 'user' ? '个人默认' : '当前项目').join('、');
  return {
    severity: 'error',
    title: invalidLayer ? '设置层无效，已阻止编辑' : '插件定义或来源不可用',
    userMessage: invalidLayer
      ? '高优先级设置层无效，不能静默使用较低层或默认值。'
      : '当前无法取得可信的字段定义，因此不能验证新值。',
    impact: [
      { state: 'blocked', message: invalidLayer
        ? `${invalidLayerLabel}设置层、普通 unset 和渲染都已阻止。`
        : '恢复可信字段定义前，不能编辑这个插件的字段设置。' },
      { state: 'preserved', message: invalidLayer
        ? '较低层或默认值只可作为预览；当前无效层仍保持不变。'
        : '已保存的设置保持不变。' },
    ],
    nextStep: invalidLayer
      ? '确认后重置整个目标设置层；不会创建备份。'
      : configUnavailableCanRecoverSource(route)
        ? '重新检查来源，然后再次打开设置。'
        : '查看技术详情，确认字段定义不可用的原因。',
    technical: {
      code: safeDiagnosticCode(route.diagnosticCode, 'configUnavailable'),
      stage: safeDiagnosticCode(route.diagnosticStage, 'read-config'),
      context: [
        { key: 'pluginId', value: route.pluginId },
        ...(route.invalidStores
          ? [{ key: 'scope' as const, value: route.invalidStores.map((store) => store.scope).join(',') }]
          : route.layer ? [{ key: 'scope' as const, value: route.layer.scope }] : []),
      ],
      checks: invalidLayer
        ? ['只删除所选 user 或 project 设置层。', '重置后重新读取继承值和默认值。']
        : ['恢复插件来源和可信插件定义。', '重新检查来源后再次打开设置。'],
    },
  };
}

function sourceDiagnostic(
  sourceId: string,
  state: SourceHealthViewModel['state'] | 'error' | 'checking' | 'update' | 'recovery' | undefined,
  detail: SourceDetailViewModel | undefined,
  generation?: CatalogSourceGenerationViewModel,
  freshness?: CatalogSourceFreshnessViewModel,
): DiagnosticSummaryViewModel | undefined {
  const unavailable = state === 'unavailable' || state === 'error';
  if (generation?.compatibility?.state === 'unsupported') {
    const { requiredCapabilities, missingCapabilities } = generation.compatibility;
    return {
      severity: 'error',
      title: '当前目录版本不兼容',
      userMessage: `当前 AW 缺少 ${missingCapabilities.length} 项所需功能支持。`,
      impact: [
        { state: 'blocked', message: '这个目录版本不能用于浏览、安装或同步。' },
        { state: 'preserved', message: '当前启用版本和已下载内容保持不变。' },
      ],
      nextStep: '升级 AW 到支持所需能力的版本，或修改来源后重新启用。',
      technical: {
        code: 'awCapabilityUnsupported',
        stage: 'resolve-source',
        sourceId,
        context: [{
          key: 'compatibility',
          value: `required: ${requiredCapabilities.join('、')}; missing: ${missingCapabilities.join('、')}`,
        }],
        checks: ['检查所需和缺少的 Catalog capability。', '升级 AW 后重新加载来源。'],
      },
    };
  }
  if (!unavailable && freshness?.state === 'checkFailed') {
    return {
      severity: 'warning',
      title: '更新检查失败',
      userMessage: '待检查版本检查失败，但当前目录版本仍可用。',
      impact: [
        { state: 'degraded', message: '当前无法判断是否有更新。' },
        { state: 'preserved', message: '浏览、安装和当前启用版本不受影响。' },
      ],
      nextStep: '返回来源详情并选择“重新检查”。',
      technical: {
        code: safeDiagnosticCode(freshness.errorCode, 'catalogFreshnessCheckFailed'),
        stage: 'probe-source',
        sourceId,
        checks: ['检查来源连接或本地目录。', '返回来源详情并重新检查。'],
      },
    };
  }
  if (freshness?.state === 'incompatible') {
    const hasActive = generation?.active !== undefined;
    return {
      severity: 'error',
      title: '待检查版本不兼容',
      userMessage: hasActive
        ? `当前 AW 缺少 ${freshness.missingCapabilities?.length ?? 0} 项待检查版本所需功能。普通更新已阻止，当前目录版本保持不变。`
        : `当前 AW 缺少 ${freshness.missingCapabilities?.length ?? 0} 项待检查版本所需功能。这个来源没有可用目录版本。`,
      impact: [
        { state: 'blocked', message: '不能直接切换到这个待检查版本。' },
        ...(hasActive ? [{ state: 'preserved' as const, message: '当前目录版本和插件浏览仍可用。' }] : []),
      ],
      nextStep: '升级 AW 到支持待检查版本所需功能的版本，或编辑来源后重新验证。',
      technical: {
        code: safeDiagnosticCode(freshness.errorCode, 'catalogincompatible'),
        stage: 'compare-candidate',
        sourceId,
        ...(freshness.missingCapabilities?.length ? {
          context: [{ key: 'compatibility' as const, value: freshness.missingCapabilities.join('、') }],
        } : {}),
        checks: ['检查缺少的 Catalog capability。', '升级 AW 后执行完整验证。'],
      },
    };
  }
  if (!unavailable && (freshness?.state === 'versionConflict'
    || freshness?.state === 'rollbackDetected')) {
    return {
      severity: 'error',
      title: freshness.state === 'versionConflict' ? '插件目录版本冲突'
        : '检测到插件目录版本回退',
      userMessage: '普通更新已阻止。当前目录版本保持不变。',
      impact: [
        { state: 'blocked', message: '不能直接切换到这个待检查版本。' },
        { state: 'preserved', message: '当前目录版本和插件浏览仍可用。' },
      ],
      nextStep: '检查待检查版本、来源引用和发布身份后，再决定是否修改来源。',
      technical: {
        code: safeDiagnosticCode(freshness.errorCode, `catalog${freshness.state}`),
        stage: 'compare-candidate',
        sourceId,
        checks: ['检查当前版本和待检查版本。', '检查来源引用和发布身份。'],
      },
    };
  }
  if (!unavailable) return undefined;
  const metadataInvalid = generation?.errorCode === 'catalogGenerationMetadataInvalid';
  return {
    severity: 'error',
    title: '插件来源不可用',
    userMessage: '当前无法读取这个来源。',
    impact: [
      { state: 'blocked', message: '当前不能浏览或安装这个来源中的插件。' },
      { state: 'preserved', message: '已安装插件和已保存设置不会被删除。' },
    ],
    nextStep: metadataInvalid && generation.recoveryEntryPath
      ? '在来源详情中选择“重新下载并修复”。'
      : '在来源详情中重新取得或修复目录版本；如仍失败，请编辑来源地址、路径或引用。',
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
            '返回来源详情并选择“重新下载并修复”。',
          ]
        : ['检查 Git URL、ref 或本地目录。', '确认当前终端具备来源授权。', '运行“重新检查来源”验证修复。'],
    },
  };
}

function capabilityDiagnostic(plugin: PluginListItemViewModel): DiagnosticSummaryViewModel {
  const missingCapabilities = plugin.missingCapabilities?.join('、')
    ?? 'Status 未提供具体 capability';
  const recovery = '升级 AW CLI 到支持此插件的版本后重试。';
  return {
    severity: 'error',
    title: '当前 AW 版本不支持此插件',
    userMessage: '当前 AW CLI 不能安装或重新安装这个插件。来源保持可用。',
    impact: [
      { state: 'blocked', message: '安装和重新安装会保持阻断，直到 AW CLI 升级。' },
      { state: 'preserved', message: '已安装插件和已保存设置不会被删除。' },
    ],
    nextStep: recovery,
    technical: {
      code: 'awCapabilityUnsupported',
      stage: 'check-capability',
      context: [{ key: 'pluginId', value: plugin.pluginId }],
      checks: [
        `确认插件需要的 capability：${missingCapabilities}。`,
        '升级 AW CLI 后重新检查当前状态。',
      ],
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
  cards?: boolean;
  columns?: number;
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
        if (props.cards) return <ObjectCardRow key={`${action.label}:${index}`}
          width={props.columns ?? 58} title={action.label}
          description={action.disabled ?? action.description ?? ''} meta={action.meta}
          tags={action.tags} focused={index === props.focus}
          compact={props.compact} />;
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
  active: boolean;
}): React.JSX.Element {
  return (
    <Box flexDirection="column">
      {props.rows.slice(props.viewport.offset, props.viewport.offset + props.viewport.limit)
        .map((row, visibleIndex) => row.menuAction ? (
          <TaskRow
            key={row.pluginId}
            title={row.name}
            description={row.description}
            meta={row.statusLabel}
            status={row.status}
            focused={props.active && props.viewport.offset + visibleIndex === props.focus}
            compact
          />
        ) : (
          <PluginListRow
            key={row.pluginId}
            name={row.name}
            sourceLabel={row.sourceLabel}
            description={row.description}
            attention={row.attention}
            placementSummary={row.placementSummary}
            tags={row.tags}
            statusLabel={row.statusLabel}
            status={row.status}
            focused={props.active && props.viewport.offset + visibleIndex === props.focus}
            anchored={!props.active && props.viewport.offset + visibleIndex === props.focus}
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
  const badge = (state: string, count: number | undefined): string => state === 'checking' ? ' …'
    : state === 'update' ? ' ↑'
      : state === 'recovery' ? ' ?'
        : state === 'error' ? ' !' : ` ${count ?? ''}`;
  const fullText = `来源  ${tabs.map((tab) => {
    const state = 'state' in tab ? tab.state : 'ready';
    return `${tab.id === props.current ? '[' : ''}${tab.label}${badge(state, tab.count)}${tab.id === props.current ? ']' : ''}  `;
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
              : state === 'update' || state === 'recovery' ? tuiTheme.statusColors.warning
              : tuiTheme.colors.muted}
          >
            {active ? '[' : ''}{tab.label}{badge(state, tab.count)}{active ? ']' : ''}{'  '}
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
    ...page.groups.filter((group) => group.fields.length > 0).map((group) => ({
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
  const current = placement.actualScopes?.map(scopeLabel).join('+') || '未启用';
  const state = placement.actualState === 'needsSync' ? '需要同步'
    : placement.actualState === 'blocked' ? '已阻断'
      : placement.health === 'ready' ? '可用'
        : placement.health === 'incomplete' ? '需要处理' : '不可用';
  return {
    value: placement.desiredScopes?.length
      ? `已保存 ${placement.desiredScopes.map(scopeLabel).join('+')} · 当前 ${current} · ${state}`
      : `当前 ${current} · ${state}`,
    status: placement.actualState === 'blocked' ? 'error' : placement.health === 'ready' ? 'success' : placement.health === 'incomplete' ? 'warning' : 'error',
    description: placement.actualState === 'needsSync' ? '已保存的使用设置与当前安装不同；可安全同步'
      : placement.actualState === 'blocked' ? '当前有安全阻断；查看恢复路径'
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
      const actualScopes = entry.actualScopes?.map(scopeLabel) ?? [];
      const actual = actualScopes.join('+') || '未启用';
      const state = entry.actualState === 'needsSync' ? '需同步'
        : entry.actualState === 'blocked' ? '已阻断'
            : entry.actualState === 'ready' ? '可用' : aggregate.value;
      return `${platformLabel(entry.platform)} · 已保存 ${desired} · 当前 ${actual} · ${state}`;
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

function dependencyReferenceUsageLabel(
  reference: DependencyPlacementReferenceViewModel,
  consumerName: string,
): string {
  const location = reference.consumer.scope === 'user'
    ? '所有项目'
    : reference.consumer.project === 'current' ? '当前项目' : '其他项目';
  return `${consumerName} · ${location} · ${platformLabel(reference.consumer.platform)}`;
}

function dependencySummaryText(summary: NonNullable<PluginListItemViewModel['dependencySummary']>): string {
  return `${summary.directCount} 个直接 · ${summary.totalCount} 个总计`;
}

function dependencyGraphRowStatus(row: DependencyGraphRow): {
  value: string;
  status: ActionItem['status'];
} {
  if (row.nodeState === 'ready') return { value: '正常', status: 'success' };
  if (row.nodeState === 'missing') return { value: '缺失', status: 'error' };
  if (row.nodeState === 'needsAttention') return { value: '待恢复', status: 'warning' };
  if (row.nodeState === 'unavailable') return { value: '不可用', status: 'error' };
  return { value: '未检查', status: 'muted' };
}

function isCatalogSourcesBootstrapFlow(snapshot: TuiControllerSnapshot): boolean {
  const route = snapshot.router.current.route;
  if (route.name === 'reviewPreparing') {
    return snapshot.reviewPreparation?.operationKind === 'catalogSourcesRecovery';
  }
  if (route.name === 'review' || route.name === 'progress') {
    return snapshot.activeReview?.operationKind === 'catalogSourcesRecovery';
  }
  return route.name === 'result'
    && snapshot.result !== undefined
    && 'operationKind' in snapshot.result
    && snapshot.result.operationKind === 'catalogSourcesRecovery';
}

function isOperationHistoryRoute(route: TuiRoute): boolean {
  return route.name === 'operationHistory'
    || route.name === 'operationDiagnostic'
    || route.name === 'operationReportPreview';
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

function isTechnicalReviewGroup(group: OperationReviewChange['group']): boolean {
  return group === 'projectIntent' || group === 'userIntent' || group === 'sharedCodexNative'
    || group === 'userActivation' || group === 'projectActivation'
    || group === 'awExtensions' || group === 'runtime';
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
  if (overlay === 'discard' || overlay === 'sessionNavigation') return 'G04';
  if (snapshot.phase !== 'ready' && !isCatalogSourcesBootstrapFlow(snapshot)
    && !isOperationHistoryRoute(snapshot.router.current.route)) return 'G01';
  return resolveRouteScreenId(snapshot.router.current.route, {
    snapshot,
    controller,
    searchMode,
  });
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
  pendingSessionNavigation?: SessionNavigation;
  pendingSessionNavigationDrafts?: ExternalDraftState[];
  onSessionNavigation?: (
    navigation: SessionNavigation,
    options?: { discardDrafts?: boolean; draftConfirmation?: ExternalDraftState[] },
  ) => Promise<SessionNavigationResult>;
  onCancelPendingSessionNavigation?: () => boolean;
  onClaimProjectIntentReminder?: (projectRoot: string, signature: string) => boolean;
}): React.JSX.Element {
  const windowSize = useWindowSize();
  const size = props.size ?? windowSize;
  const policy = resolveTuiSizePolicy(size.columns, size.rows);
  const [snapshot, setSnapshot] = useState(() => props.controller.snapshot);
  const [overlay, setOverlay] = useState<Overlay>();
  const [overlayFocus, setOverlayFocus] = useState(0);
  const [operationConfirmation, setOperationConfirmation] = useState<OperationConfirmationOverlay>();
  const [sourceTransportOverlay, setSourceTransportOverlay] = useState<SourceTransportOverlay>();
  const [pluginListChooser, setPluginListChooser] = useState<PluginListChooser>();
  const [projectReminderOpen, setProjectReminderOpen] = useState(false);
  const [discardForExit, setDiscardForExit] = useState(false);
  const [discardForSessionNavigation, setDiscardForSessionNavigation] = useState<SessionNavigation>();
  const [discardDraftConfirmation, setDiscardDraftConfirmation] = useState<ExternalDraftState[]>();
  const [focus, setFocus] = useState(0);
  const [focusZone, setFocusZone] = useState<'content' | 'actions'>('content');
  const [pinnedActionFocus, setPinnedActionFocus] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [searchFocus, setSearchFocus] = useState(false);
  const [query, setQuery] = useState(
    snapshot.router.current.context.query ?? '',
  );
  const [installFilter, setInstallFilter] = useState<PluginInstallFilter>(
    snapshot.router.current.context.installFilter
      ?? (snapshot.router.current.route.name === 'pluginList'
        && snapshot.router.current.route.mode === 'installed' ? 'installed' : 'all'),
  );
  const [scope, setScope] = useState<Scope>('user');
  const [selectedTargets, setSelectedTargets] = useState<PlatformName[]>([]);
  const [installPlatformScopes, setInstallPlatformScopes] = useState<Partial<Record<PlatformName, Scope>>>({});
  const [uninstallTargetKeys, setUninstallTargetKeys] = useState<string[]>([]);
  const [technicalRouteKey, setTechnicalRouteKey] = useState<string>();
  const [exitAfterBusy, setExitAfterBusy] = useState(false);
  const [exitAfterPreparation, setExitAfterPreparation] = useState(false);
  const [, setClockTick] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [configPage, setConfigPage] = useState<ConfigPageViewModel>();
  const [configLayerCounts, setConfigLayerCounts] = useState<Record<string, number>>({});
  const [configLayerPages, setConfigLayerPages] = useState<Partial<Record<Scope, ConfigPageViewModel>>>({});
  const [configDrafts, setConfigDrafts] = useState<Partial<Record<Scope, ConfigLayerDraft>>>({});
  const [configCandidate, setConfigCandidate] = useState<ConfigCandidate>();
  const [objectDrafts, setObjectDrafts] = useState<Record<string, PluginConfigObject>>({});
  const [changedObjectDraftKeys, setChangedObjectDraftKeys] = useState<string[]>([]);
  const [objectError, setObjectError] = useState<string>();
  const [inputValue, setInputValue] = useState('');
  const [inputError, setInputError] = useState<string>();
  const [configActionError, setConfigActionError] = useState<string>();
  const [configGroupChooserOpen, setConfigGroupChooserOpen] = useState(false);
  const [configGroupChoiceFocus, setConfigGroupChoiceFocus] = useState(0);
  const [actionError, setActionError] = useState<string>();
  const [configResetAvailability, setConfigResetAvailability] = useState<Partial<Record<
    Scope,
    Awaited<ReturnType<TuiController['getConfigResetAvailability']>>
  >>>({});
  const [sourceDraft, setSourceDraft] = useState<SourceDraft>();
  const [batchDraft, setBatchDraft] = useState<BatchDraft>();
  const [batchTargetOffset, setBatchTargetOffset] = useState(0);
  const [portableResultDetailOpen, setPortableResultDetailOpen] = useState(false);
  const [portableResultDetailOffset, setPortableResultDetailOffset] = useState(0);
  const [portableRecheckBusy, setPortableRecheckBusy] = useState(false);
  const portableResultDetailPairKey = useRef<string | undefined>(undefined);
  const portableResultDetailReturnFocus = useRef(0);
  const [expandedDependencyPluginIds, setExpandedDependencyPluginIds] = useState<Set<string>>();
  const [sourceInput, setSourceInput] = useState('');
  const [sourceInputError, setSourceInputError] = useState<string>();
  const [pendingReviewIntent, setPendingReviewIntent] = useState<OperationIntent>();
  const pendingReviewIntentRef = useRef<OperationIntent | undefined>(undefined);
  const pendingActionFocus = useRef<string | undefined>(undefined);
  const [scriptTimeoutInput, setScriptTimeoutInput] = useState(String(SCRIPT_TIMEOUT_DEFAULT_MS));
  const [scriptTimeoutError, setScriptTimeoutError] = useState<string>();
  const [sourceReferenceSummary, setSourceReferenceSummary] = useState<Awaited<ReturnType<TuiController['inspectSourceRemoval']>>>();
  const [catalogStoreStatus, setCatalogStoreStatus] = useState<CatalogStoreStatusResult>();
  const [catalogStoreError, setCatalogStoreError] = useState(false);
  const [catalogStoreRefresh, setCatalogStoreRefresh] = useState(0);
  const [sourceDependenciesExpanded, setSourceDependenciesExpanded] = useState(false);
  const [portableAgentInput, setPortableAgentInput] = useState('');
  const [portableSelectionView, setPortableSelectionView] = useState<'all' | 'selected'>('all');
  const [portableToolsOpen, setPortableToolsOpen] = useState(false);
  const [portableEmptySelectionOpen, setPortableEmptySelectionOpen] = useState(false);
  const [reportSaveMode, setReportSaveMode] = useState(false);
  const [reportSavePath, setReportSavePath] = useState('');
  const [reportSaveResult, setReportSaveResult] = useState<string>();
  const [reportSaveError, setReportSaveError] = useState<string>();
  const [draftOwner, setDraftOwner] = useState<string>();
  const dynamicMenuFocus = useRef<DynamicMenuFocus | undefined>(undefined);
  const pluginListFocusId = useRef<string | undefined>(undefined);
  const dependencyGraphContexts = useRef(new Map<string, DependencyGraphSessionContext>());
  const selectedDependencyReferenceIndex = useRef(0);
  const externalDraftRevision = useRef({ config: 0, source: 0, batch: 0 });
  const previousExternalDraftValues = useRef({
    configDrafts, configCandidate, objectDrafts, changedObjectDraftKeys, sourceDraft, batchDraft,
  });
  const externalDraftFlowIds = useRef(new Map<string, string>());
  const configOverviewAnchors = useRef(new Map<string, { overviewFrameId: string; flowId?: string }>());
  const exitSent = useRef(false);
  const operationBusy = useRef(false);
  const route = snapshot.router.current.route;
  if (route.name === 'configFields') {
    configOverviewAnchors.current.set(route.pluginId, {
      overviewFrameId: snapshot.router.currentFrameId,
      ...(snapshot.router.currentFlowId ? { flowId: snapshot.router.currentFlowId } : {}),
    });
  }
  const configDraftCount = (['project', 'user'] as const).reduce((count, draftScope) => {
    const draft = configDrafts[draftScope];
    return count + Object.keys(draft?.updates ?? {}).length + (draft?.removes.length ?? 0);
  }, 0);
  const draftUpdates = {
    ...(configDrafts.user?.updates ?? {}),
    ...(configDrafts.project?.updates ?? {}),
  };
  const draftRemoves = [...new Set([
    ...(configDrafts.user?.removes ?? []),
    ...(configDrafts.project?.removes ?? []),
  ])];
  const definition = routeDefinition(route);
  const rendererFamily = definition.rendererFamily;
  const routeKey = JSON.stringify(route);
  const showTechnical = technicalRouteKey === routeKey;
  const setShowTechnical = (next: boolean | ((current: boolean) => boolean)): void => {
    const visible = typeof next === 'function' ? next(showTechnical) : next;
    setTechnicalRouteKey(visible ? routeKey : undefined);
  };
  const resetRootUiState = (): void => {
    setFocus(0);
    setScrollOffset(0);
    setSearchFocus(false);
    setQuery('');
    setShowTechnical(false);
    setSourceDependenciesExpanded(false);
    setBatchTargetOffset(0);
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
  useEffect(() => {
    setPortableResultDetailOpen(false);
    setPortableResultDetailOffset(0);
    portableResultDetailPairKey.current = undefined;
  }, [route.name, route.name === 'result' ? route.operationId : '']);
  const tooSmall = policy.mode === 'too-small';
  const requestExit = (request: ConsoleExitRequest): void => {
    if (exitSent.current) return;
    exitSent.current = true;
    props.onExit?.(request);
  };

  useEffect(() => {
    const unsubscribe = props.controller.subscribe(setSnapshot);
    if (props.controller.snapshot.phase === 'idle') {
      void props.controller.load().catch((error: unknown) => {
        if (error instanceof Error && error.name === 'AbortError') return;
        props.controller.recordUiFailure(error, { code: 'tuiLoadFailed', stage: 'ui-load' });
      });
    }
    return () => {
      unsubscribe();
      if (props.ownsController) props.controller.dispose();
    };
  }, [props.controller, props.ownsController]);
  useEffect(() => {
    const reminder = snapshot.projectIntentReminder;
    if (!props.onClaimProjectIntentReminder
      || snapshot.phase !== 'ready'
      || route.name !== 'home'
      || !reminder
      || reminder.actionableTargets.length + reminder.blockedTargets.length === 0
      || overlay
      || operationConfirmation
      || sourceTransportOverlay
      || dirty
      || props.controller.hasSessionDraft) return;
    if (props.onClaimProjectIntentReminder(reminder.projectRoot, reminder.signature)) {
      setOverlayFocus(0);
      setProjectReminderOpen(true);
    }
  }, [
    props.controller,
    props.onClaimProjectIntentReminder,
    snapshot.phase,
    snapshot.projectIntentReminder?.signature,
    route.name,
    overlay,
    operationConfirmation,
    sourceTransportOverlay,
    dirty,
  ]);
  useEffect(() => {
    const reminder = snapshot.projectIntentReminder;
    if (projectReminderOpen
      && (!reminder || reminder.actionableTargets.length + reminder.blockedTargets.length === 0)) {
      setProjectReminderOpen(false);
    }
  }, [projectReminderOpen, snapshot.projectIntentReminder]);
  useEffect(() => {
    if (route.name !== 'pluginContent' || snapshot.phase !== 'ready') return;
    void props.controller.loadPluginContent(route.pluginId);
  }, [props.controller, snapshot.phase, route.name === 'pluginContent' ? route.pluginId : undefined]);
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
    if (snapshot.result.operationKind === 'configSaveBatch') {
      const savedScopes = new Set(snapshot.result.summary.configGroups
        ?.filter((group) => group.configSaved).map((group) => group.scope) ?? []);
      const nextDrafts = Object.fromEntries(Object.entries(configDrafts)
        .filter(([draftScope]) => !savedScopes.has(draftScope as Scope)));
      setConfigDrafts(nextDrafts);
      setDirty(Object.keys(nextDrafts).length > 0);
      setConfigCandidate(undefined);
      setObjectDrafts({});
      setChangedObjectDraftKeys([]);
      setObjectError(undefined);
    } else if (snapshot.result.operationKind === 'configSave'
      || snapshot.result.operationKind === 'configReset') {
      const completedScope = snapshot.result.summary.configScope;
      const preserveAll = snapshot.result.operationKind === 'configSave'
        && snapshot.result.summary.configRetryApply === true;
      const nextDrafts = { ...configDrafts };
      if (!preserveAll && completedScope) delete nextDrafts[completedScope];
      setConfigDrafts(nextDrafts);
      setDirty(Object.keys(nextDrafts).length > 0);
      setConfigCandidate(undefined);
      setObjectDrafts({});
      setChangedObjectDraftKeys([]);
      setObjectError(undefined);
    }
    if ((snapshot.result.operationKind === 'sourceMutation'
      || snapshot.result.operationKind === 'catalogGeneration') && sourceDraft) {
      setSourceDraft(undefined);
      setDirty(configDraftCount + changedObjectDraftKeys.length > 0);
    }
  }, [
    route.name,
    snapshot.result?.operationId,
    snapshot.result?.state,
    snapshot.result?.operationKind,
  ]);
  useEffect(() => {
    if (route.name !== 'result' || snapshot.result?.operationKind !== 'pluginWriteBatch') return;
    setBatchDraft(undefined);
    setDirty(false);
  }, [route.name, snapshot.result?.operationKind]);
  useEffect(() => {
    if (route.name !== 'result'
      || snapshot.result?.state !== 'succeeded'
      || snapshot.result.operationKind !== 'pluginWriteTask'
      || !('returnRoute' in snapshot.result)
      || snapshot.result.returnRoute?.name !== 'pluginWriteTask'
      || snapshot.result.returnRoute.goal !== snapshot.result.summary.task?.goal
      || snapshot.result.returnRoute.batchOrigin?.owner !== 'batch-write'
      || snapshot.result.returnRoute.batchOrigin.flowId !== batchDraft?.flowId) return;
    setBatchDraft(undefined);
    setDirty(false);
  }, [batchDraft?.flowId, route.name, snapshot.result]);
  useEffect(() => {
    if (!batchDraft || (route.name !== 'batchSelection'
      && route.name !== 'batchInstallPlatforms'
      && route.name !== 'batchInstallScope'
      && route.name !== 'batchPlacement')) return;
    setDirty(true);
  }, [batchDraft, route.name]);
  useEffect(() => {
    if (route.name !== 'sourceAdd') setSourceInput('');
  }, [route.name]);
  useEffect(() => {
    if (route.name === 'operationReportPreview') return;
    setReportSaveMode(false);
    setReportSavePath('');
    setReportSaveResult(undefined);
    setReportSaveError(undefined);
  }, [route.name]);
  useEffect(() => {
    if (route.name !== 'home') return;
    resetRootUiState();
  }, [route.name]);
  useEffect(() => {
    if (route.name === 'portableAgentInput') {
      setPortableAgentInput(snapshot.portableDraft?.requestedAgents.join(' ') ?? '');
    } else setPortableAgentInput('');
  }, [route.name, route.name === 'portableAgentInput' ? snapshot.portableDraft?.requestedAgents.join('\0') : '']);
  useEffect(() => {
    if (route.name !== 'configFieldEditor' && route.name !== 'configObjectPropertyEditor') {
      setInputValue('');
    }
  }, [route.name]);
  useEffect(() => {
    if (route.name !== 'configFields') setConfigGroupChooserOpen(false);
  }, [route.name]);
  const configRoute = route.name === 'configFields'
    || route.name === 'configFieldEditor'
    || route.name === 'configObjectPropertyEditor'
    || route.name === 'configFieldAction'
    || route.name === 'configSave'
    ? route
    : undefined;
  const configRouteOwner = configRoute ? configOwnerKey(configRoute) : undefined;
  const configFlowPluginId = configRoute?.pluginId
    ?? (route.name === 'configLayer' ? route.pluginId : undefined);
  useEffect(() => {
    const previous = previousExternalDraftValues.current;
    if (previous.configDrafts !== configDrafts
      || previous.configCandidate !== configCandidate
      || previous.objectDrafts !== objectDrafts
      || previous.changedObjectDraftKeys !== changedObjectDraftKeys) {
      externalDraftRevision.current.config += 1;
    }
    if (previous.sourceDraft !== sourceDraft) externalDraftRevision.current.source += 1;
    if (previous.batchDraft !== batchDraft) externalDraftRevision.current.batch += 1;
    previousExternalDraftValues.current = {
      configDrafts, configCandidate, objectDrafts, changedObjectDraftKeys, sourceDraft, batchDraft,
    };
    const currentFlowId = snapshot.router.currentFlowId;
    if (currentFlowId && configRouteOwner) {
      externalDraftFlowIds.current.set(configRouteOwner, currentFlowId);
    }
    if (currentFlowId && sourceDraft) externalDraftFlowIds.current.set(sourceDraft.owner, currentFlowId);
    const drafts: ExternalDraftState[] = [];
    if ((dirty || configCandidate || changedObjectDraftKeys.length > 0) && draftOwner) {
      const flowId = externalDraftFlowIds.current.get(draftOwner);
      drafts.push({
        kind: 'configDraft', owner: draftOwner, revision: externalDraftRevision.current.config,
        ...(flowId ? { flowId } : {}),
      });
    }
    if (sourceDraft) {
      const flowId = externalDraftFlowIds.current.get(sourceDraft.owner);
      drafts.push({
        kind: 'sourceDraft', owner: sourceDraft.owner, revision: externalDraftRevision.current.source,
        ...(flowId ? { flowId } : {}),
      });
    }
    if (batchDraft) {
      drafts.push({
        kind: 'batchDraft', owner: 'batch-write', revision: externalDraftRevision.current.batch,
        flowId: batchDraft.flowId,
      });
    }
    props.controller.setExternalDraftState(drafts);
  }, [
    props.controller, batchDraft, changedObjectDraftKeys, configRouteOwner, dirty, draftOwner,
    configDrafts, configCandidate, objectDrafts, route.name, snapshot.router.currentFlowId, sourceDraft,
  ]);
  useEffect(() => () => props.controller.setExternalDraftState(), [props.controller]);
  const currentConfigPage = configPageMatches(configPage, configRoute) ? configPage : undefined;
  const configDraftIssues = (() => {
    const issues: ConfigDraftIssue[] = [];
    for (const draftScope of ['project', 'user'] as const) {
      const draft = configDrafts[draftScope];
      if (!draft) continue;
      const page = configLayerPages[draftScope];
      if (!page) continue;
      const fields = new Map(page.groups.flatMap((group) => group.fields)
        .map((field) => [field.key, field]));
      for (const [key, value] of Object.entries(draft.updates)) {
        const field = fields.get(key);
        if (!field || !configFieldCanSet(field)
          || validatePluginConfigValue(field.definition, value, key).length > 0) {
          issues.push({ scope: draftScope, key, source: 'update' });
        }
      }
      for (const key of draft.removes) {
        const field = fields.get(key);
        if (!field || !configFieldCanUnset(field)) {
          issues.push({ scope: draftScope, key, source: 'remove' });
        }
      }
    }
    return issues;
  })();
  useEffect(() => {
    if (!configFlowPluginId) return;
    const abort = new AbortController();
    setConfigLayerPages({});
    const layers = [
      { key: 'user', layer: { scope: 'user' as const } },
      { key: 'project', layer: { scope: 'project' as const } },
    ];
    void Promise.allSettled(layers.map(async ({ key, layer }) => ({
      key,
      page: await props.controller.getConfigPage(configFlowPluginId, layer, abort.signal),
    }))).then((results) => {
      if (abort.signal.aborted) return;
      setConfigLayerCounts(Object.fromEntries(results.flatMap((result) =>
        result.status === 'fulfilled' ? [[result.value.key, result.value.page.storedCount]] : [])));
      setConfigLayerPages(Object.fromEntries(results.flatMap((result) =>
        result.status === 'fulfilled' ? [[result.value.key, result.value.page]] : [])));
    });
    return () => abort.abort();
  }, [props.controller, configFlowPluginId]);
  useEffect(() => {
    if (!configRoute) return;
    const abort = new AbortController();
    const expectedPluginId = configRoute.pluginId;
    const expectedLayer = JSON.stringify(configRoute.layer);
    const owner = configOwnerKey(configRoute);
    setConfigPage(undefined);
    if (draftOwner !== owner) {
      setDraftOwner(owner);
      if (draftOwner !== undefined) {
        setConfigDrafts({});
        setConfigCandidate(undefined);
        setObjectDrafts({});
        setChangedObjectDraftKeys([]);
        setObjectError(undefined);
        setDirty(false);
        setConfigActionError(undefined);
      }
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
          const invalidStores = error instanceof TuiConfigInvalidStoreError
            ? error.evidence
            : undefined;
          const layer = invalidStores?.length === 1
            ? { scope: invalidStores[0]!.scope }
            : !invalidStores && configRoute.layer.scope !== 'effective'
              ? { scope: configRoute.layer.scope as Scope }
              : undefined;
          const code = typeof error === 'object' && error !== null && 'code' in error
            ? safeDiagnosticCode((error as { code?: unknown }).code, 'configUnavailable')
            : error instanceof Error
              ? safeDiagnosticCode(error.message.split(':', 1)[0], 'configUnavailable')
              : 'configUnavailable';
          const overviewAnchor = configOverviewAnchors.current.get(expectedPluginId);
          props.controller.replace({
            name: 'configUnavailable',
            pluginId: expectedPluginId,
            ...(overviewAnchor && overviewAnchor.flowId === snapshot.router.currentFlowId
              ? { overviewFrameId: overviewAnchor.overviewFrameId } : {}),
            diagnosticCode: code,
            diagnosticStage: 'read-config',
            ...(invalidStores ? { invalidStores } : {}),
            ...(layer ? { layer } : {}),
            ...(configRoute ? { resumeRoute: structuredClone(configRoute.name === 'configSave'
              ? { name: 'configFields' as const, pluginId: configRoute.pluginId, layer: configRoute.layer }
              : configRoute) } : {}),
            ...(configRoute ? { resumeContext: {
              ...(snapshot.router.current.context.configGroupId !== undefined
                ? { configGroupId: snapshot.router.current.context.configGroupId } : {}),
              ...(snapshot.router.current.context.focusIndex !== undefined
                ? { focusIndex: snapshot.router.current.context.focusIndex } : {}),
              ...(snapshot.router.current.context.scrollOffset !== undefined
                ? { scrollOffset: snapshot.router.current.context.scrollOffset } : {}),
            } } : {}),
          });
        }
      });
    return () => abort.abort();
  }, [configRoute?.pluginId, configRoute?.layer.scope, props.controller]);

  useEffect(() => {
    if (route.name !== 'configUnavailable'
      || (!route.invalidStores?.length && !route.storedScopes?.length && !route.layer)) {
      setConfigResetAvailability({});
      return;
    }
    const abort = new AbortController();
    setConfigResetAvailability({});
    const scopes = route.invalidStores?.map(({ scope }) => scope)
      ?? route.storedScopes
      ?? (route.layer ? [route.layer.scope] : []);
    void Promise.all(scopes.map(async (scope) => {
      try {
        return {
          scope,
          availability: await props.controller.getConfigResetAvailability(route.pluginId, { scope }),
        };
      } catch {
        return { scope, availability: undefined };
      }
    })).then((results) => {
      if (!abort.signal.aborted) {
        setConfigResetAvailability(Object.fromEntries(results
          .filter((result) => result.availability !== undefined)
          .map((result) => [result.scope, result.availability!])));
      }
    });
    return () => abort.abort();
  }, [
    props.controller,
    route.name,
    route.name === 'configUnavailable' ? route.pluginId : '',
    route.name === 'configUnavailable'
      ? route.invalidStores?.map((store) => `${store.scope}:${store.code}`).join('|') ?? ''
      : '',
    route.name === 'configUnavailable' ? route.storedScopes?.join('|') ?? '' : '',
    route.name === 'configUnavailable' ? route.layer?.scope ?? '' : '',
  ]);

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
    if (route.name === 'sourceList') count = props.controller.listSources().length;
    else if (route.name === 'issueList') {
      const issueCount = props.controller.listUserIssues().length;
      count = issueCount || 2;
    } else if (route.name === 'operationHistory') {
      count = snapshot.operationHistorySummaries.length + 1;
    } else if (route.name === 'pluginList') {
      const items = props.controller.listPlugins({
        mode: route.mode,
        ...(route.sourceId ? { sourceId: route.sourceId } : {}),
        ...(query ? { query } : {}),
        installFilter,
      });
      const sourceUnavailable = route.sourceId !== undefined
        && props.controller.getSourceOverview(route.sourceId).health?.state === 'unavailable';
      count = pluginListRowIds(route.mode, items, query, sourceUnavailable).length || 1;
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
  useEffect(() => {
    if (route.name !== 'pluginWriteTask' || route.goal !== 'update') return;
    if (snapshot.router.current.context.autoPreparedUpdate) return;
    const targetKeys = route.targetKeys;
    const versionEvidence = route.versionEvidence;
    if (!targetKeys || targetKeys.length === 0 || !versionEvidence) return;
    const allCandidates = props.controller.listPluginWriteTaskCandidates('update');
    const retainedTargetKeys = new Set(targetKeys);
    const frozenPluginIds = new Set(route.recommendedPluginIds
      ?? targetKeys.map((targetKey) => targetKey.split('\0')[0]!).filter(Boolean));
    const currentFrozenCandidates = allCandidates.filter((candidate) =>
      frozenPluginIds.has(candidate.target.pluginId));
    if (currentFrozenCandidates.length !== targetKeys.length
      || currentFrozenCandidates.some((candidate) =>
        !retainedTargetKeys.has(pluginWriteTaskTargetKey(candidate)))) return;
    const currentByKey = new Map(allCandidates.map((candidate) => [
      pluginWriteTaskTargetKey(candidate), candidate,
    ]));
    const candidates = targetKeys.flatMap((targetKey) => {
      const candidate = currentByKey.get(targetKey);
      return candidate ? [candidate] : [];
    });
    const representedPluginIds = new Set(candidates.map((candidate) => candidate.target.pluginId));
    if (candidates.length !== targetKeys.length
      || candidates.some((candidate) => !candidate.eligible
        || !frozenPluginIds.has(candidate.target.pluginId))
      || [...frozenPluginIds].some((pluginId) => !representedPluginIds.has(pluginId))) return;
    const currentVersionEvidence = Object.assign({}, ...[...frozenPluginIds].map((pluginId) => {
      const candidatePlugin = props.controller.getPluginOverview(pluginId);
      return candidatePlugin ? pluginWriteTaskVersionEvidence(
        candidatePlugin,
        candidates.filter((candidate) => candidate.target.pluginId === pluginId),
      ) : {};
    }));
    if (Object.keys(currentVersionEvidence).length !== targetKeys.length
      || Object.entries(currentVersionEvidence).some(([key, version]) => versionEvidence[key] !== version)
      || Object.keys(versionEvidence).some((key) => currentVersionEvidence[key] === undefined)) return;
    props.controller.updatePageContext({ autoPreparedUpdate: true });
    beginReview({
      kind: 'pluginWriteTask',
      goal: 'update',
      targets: candidates.map((candidate) => candidate.target),
      executionPolicy: 'all',
    }, props.controller.pluginWriteTaskReturnRoute(route));
  }, [
    props.controller,
    route.name,
    route.name === 'pluginWriteTask' ? route.goal : '',
    route.name === 'pluginWriteTask' ? route.targetKeys?.join('\0') ?? '' : '',
    route.name === 'pluginWriteTask' ? route.recommendedPluginIds?.join('\0') ?? '' : '',
    route.name === 'pluginWriteTask' ? JSON.stringify(route.versionEvidence ?? {}) : '',
    snapshot.router.current.context.autoPreparedUpdate,
    snapshot.viewModel,
  ]);

  useEffect(() => {
    if (route.name !== 'operationReportPreview') return;
    setScrollOffset(0);
  }, [route.name, route.name === 'operationReportPreview' ? route.recordId : '']);
  useEffect(() => {
    if (route.name !== 'catalogStoreOverview') return;
    let current = true;
    setCatalogStoreStatus(undefined);
    setCatalogStoreError(false);
    void props.controller.inspectCatalogStore().then((result) => {
      if (current) setCatalogStoreStatus(result);
    }).catch(() => {
      if (current) setCatalogStoreError(true);
    });
    return () => { current = false; };
  }, [props.controller, route.name, snapshot.result, catalogStoreRefresh]);
  useEffect(() => {
    if (route.name !== 'pluginDependencies') return;
    const key = dependencyGraphContextKey(route.pluginId, 'dependencies');
    const stored = dependencyGraphContexts.current.get(key);
    const overviews = props.controller.listPluginDependencyOverviews();
    const knownPluginIds = new Set(overviews.flatMap((overview) => [
      overview.pluginId,
      ...overview.dependencies.map((item) => item.pluginId),
      ...overview.dependents.map((item) => item.pluginId),
    ]));
    const expandedPluginIds = stored
      ? new Set([...stored.expandedPluginIds].filter((pluginId) => knownPluginIds.has(pluginId)))
      : undefined;
    const projection = buildUnifiedDependencyGraphProjection({
      overviews,
      rootPluginId: route.pluginId,
      ...(expandedPluginIds ? { expandedPluginIds } : {}),
    });
    const actionIds = unifiedDependencyGraphActionIds(projection);
    const normalizedExpanded = expandedPluginIds ?? new Set([
      ...projection.dependencies.defaultExpandedPluginIds,
      ...projection.dependents.defaultExpandedPluginIds,
    ]);
    const focusedIndex = stored?.focusedActionId
      ? actionIds.indexOf(stored.focusedActionId)
      : 0;
    const nextFocus = focusedIndex >= 0 ? focusedIndex : 0;
    const anchorIndex = stored?.scrollAnchorActionId
      ? actionIds.indexOf(stored.scrollAnchorActionId)
      : 0;
    const nextScroll = Math.max(0, anchorIndex >= 0 ? Math.min(anchorIndex, nextFocus) : 0);
    setExpandedDependencyPluginIds(normalizedExpanded);
    setFocus(nextFocus);
    setScrollOffset(nextScroll);
    dependencyGraphContexts.current.set(key, {
      expandedPluginIds: normalizedExpanded,
      ...(actionIds[nextFocus] ? { focusedActionId: actionIds[nextFocus] } : {}),
      ...(actionIds[nextScroll] ? { scrollAnchorActionId: actionIds[nextScroll] } : {}),
    });
  }, [
    props.controller,
    route.name,
    route.name === 'pluginDependencies' ? route.pluginId : '',
    snapshot.viewModel,
  ]);
  useEffect(() => {
    if (route.name !== 'pluginList' || snapshot.phase !== 'ready'
      || snapshot.router.current.context.focusIndex !== undefined) return;
    const items = props.controller.listPlugins({
      mode: route.mode,
      ...(route.sourceId ? { sourceId: route.sourceId } : {}),
      ...(query ? { query } : {}),
      installFilter,
    });
    if (items.length === 0) return;
    setFocus(0);
  }, [props.controller, route.name, route.name === 'pluginList' ? route.mode : '',
    route.name === 'pluginList' ? route.sourceId : '', snapshot.phase]);
  useEffect(() => {
    setBatchTargetOffset(0);
  }, [route.name, route.name === 'review' || route.name === 'result' ? route.operationId : '']);

  const activeField = route.name === 'configFieldEditor'
    || route.name === 'configObjectPropertyEditor'
    || route.name === 'configFieldAction'
    ? currentConfigPage?.groups.flatMap((group) => group.fields).find((field) => field.key === route.fieldKey)
    : undefined;
  useEffect(() => {
    if (!configRoute
      || configRoute.name === 'configFields'
      || configRoute.name === 'configSave'
      || !currentConfigPage
      || activeField) return;
    props.controller.replace({
      name: 'configFields',
      pluginId: configRoute.pluginId,
      layer: configRoute.layer,
    }, snapshot.router.current.context);
  }, [props.controller, configRoute, currentConfigPage, activeField, snapshot.router.current.context]);
  const activeObjectKey = activeField?.type === 'object' && configRoute
    ? `${configOwnerKey(configRoute)}\0${activeField.key}`
    : undefined;
  const objectValueFromUpdate = activeField && Object.hasOwn(draftUpdates, activeField.key)
    && typeof draftUpdates[activeField.key] === 'object'
    ? draftUpdates[activeField.key] as PluginConfigObject
    : undefined;
  const activeCandidateMutation = activeField ? configCandidate?.mutations[activeField.key] : undefined;
  const objectValueFromCandidate = activeCandidateMutation?.kind === 'set'
    && typeof activeCandidateMutation.value === 'object'
    ? activeCandidateMutation.value as PluginConfigObject
    : undefined;
  const objectValueFromField = activeField?.draftValue !== null
    && typeof activeField?.draftValue === 'object'
    && !Array.isArray(activeField.draftValue)
    ? activeField.draftValue as PluginConfigObject
    : undefined;
  const activeObjectDraft = activeObjectKey
    ? objectDrafts[activeObjectKey] ?? objectValueFromCandidate ?? objectValueFromUpdate ?? objectValueFromField ?? {}
    : undefined;
  const activePropertyDefinition = route.name === 'configObjectPropertyEditor'
    && activeField?.definition.type === 'object' && route.propertyKey !== undefined
    ? activeField.definition.properties?.[route.propertyKey]
      ?? (activeField.definition.additionalProperties === false
        ? undefined
        : activeField.definition.additionalProperties)
    : undefined;
  const activePropertySensitive = activeField?.sensitive === true
    || activePropertyDefinition?.sensitive === true;
  useEffect(() => {
    if (route.name !== 'configFieldEditor' || !activeField) return;
    const candidate = configCandidate?.mutations[activeField.key];
    const draft = candidate?.kind === 'set' ? candidate.value : draftUpdates[activeField.key];
    setInputValue(activeField.sensitive
      ? draft === undefined ? '' : String(draft)
      : typeof (draft ?? activeField.draftValue ?? activeField.value) === 'object'
        ? ''
        : String(draft ?? activeField.draftValue ?? activeField.value ?? ''));
    setInputError(undefined);
  }, [
    route.name,
    route.name === 'configFieldEditor' ? `${route.fieldKey}:${route.mode ?? ''}` : '',
    activeField?.key,
    configCandidate,
  ]);
  useEffect(() => {
    if (route.name !== 'configObjectPropertyEditor') return;
    const current = route.propertyKey !== undefined && activeObjectDraft
      ? activeObjectDraft[route.propertyKey]
      : undefined;
    setInputValue(route.stage === 'key' || activePropertySensitive
      ? ''
      : current === undefined ? '' : String(current));
    setInputError(undefined);
  }, [
    route.name,
    route.name === 'configObjectPropertyEditor'
      ? `${route.fieldKey}:${route.propertyKey ?? ''}:${route.stage}`
      : '',
  ]);
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
    if (route.name !== 'scriptTimeout') return;
    setScriptTimeoutInput(String(pendingReviewIntent && 'scriptTimeoutMs' in pendingReviewIntent
      ? pendingReviewIntent.scriptTimeoutMs ?? SCRIPT_TIMEOUT_DEFAULT_MS
      : SCRIPT_TIMEOUT_DEFAULT_MS));
    setScriptTimeoutError(undefined);
  }, [route.name, route.name === 'scriptTimeout' ? route.owner : '']);
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
  useEffect(() => {
    if (route.name !== 'portableSkillSelect') setPortableToolsOpen(false);
  }, [route.name]);
  useEffect(() => {
    if (route.name !== 'portableSkillSelect') setPortableEmptySelectionOpen(false);
  }, [route.name]);

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
  const portableVisibleCandidates = route.name === 'portableSkillSelect' && snapshot.portableDraft
    ? portableSelectionView === 'selected'
      ? snapshot.portableDraft.candidates.filter((candidate) => candidate.selected)
      : snapshot.portableDraft.candidates
    : [];
  const supportsTechnicalDetails = snapshot.phase === 'error'
    || Boolean(snapshot.projectIntentIssue)
    || route.name === 'projectStatus'
    || Boolean(route.name === 'reviewPreparing' && snapshot.reviewPreparation?.code)
    || Boolean(route.name === 'progress' && snapshot.progress.messages.length > 0)
    || Boolean(route.name === 'review' && snapshot.activeReview?.technicalDetails?.length)
    || Boolean(route.name === 'issueDetail' && issue
      && issue.diagnostic.technical)
    || Boolean(route.name === 'pluginDependencies' && plugin)
    || Boolean(route.name === 'pluginDependencyNode' && plugin)
    || route.name === 'catalogStoreRules'
    || portableVariantCandidates.length > 0
    || Boolean(route.name === 'portableDependencies' && plugin
      && props.controller.getPluginDependencyOverview(plugin.pluginId)?.dependencies.length)
    || Boolean(route.name === 'portableBlocker' && plugin)
    || Boolean(route.name === 'configUnavailable' && plugin)
    || Boolean(route.name === 'result' && snapshot.result && 'operationKind' in snapshot.result
      && snapshot.result.operationKind === 'portableInstall');
  const canOpenHelp = !tooSmall
    && !isCharacterInputMode(route, searchFocus);
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
  let referenceDetailPagination: { total: number; pageRows: number } | undefined;
  let confirmationPagination: { total: number; pageRows: number } | undefined;
  let pluginRows: PluginListRowViewModel[] = [];
  let pinnedActions: ActionItem[] = [];
  let selectAllPortableCandidates: ActionItem | undefined;
  let togglePluginListFilter: (() => void) | undefined;
  let movePluginListSource: ((direction: -1 | 1) => void) | undefined;
  let choosePluginListFilter: ((filter: PluginInstallFilter) => void) | undefined;
  let choosePluginListSource: ((sourceId: string) => void) | undefined;
  let visibleConfigTabs: ConfigTab[] = [];
  let activeConfigTabId: string | undefined;
  const dynamicMenu = plugin && route.name === 'platform'
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
  const actionViewportStaticRows = route.name === 'dependencyPlacement'
    ? dependencyPlacementStaticRows
    : route.name === 'pluginDetail' ? policy.mode === 'compact' ? 6 : 8
    : route.name === 'operationHistory' ? 4
      : route.name === 'operationReportPreview' ? 5 : 0;
  let currentActionViewportLineBudget = pageActionBudget(actionViewportStaticRows);
  let portableResultDetailPagination: { total: number; pageRows: number } | undefined;
  const responsiveBudget = (compactRows: number, standardRows: number): number => {
    const baseline = policy.mode === 'compact' ? 18 : 24;
    const base = policy.mode === 'compact' ? compactRows : standardRows;
    return base + Math.max(0, size.rows - baseline);
  };
  const sourceTechnicalPageRows = Math.max(1, contentRowBudget({
    terminalRows: size.rows, description: false, compact: policy.mode === 'compact', staticRows: 6,
  }));
  const resolveSourceTechnicalDiagnostic = (sourceId: string): DiagnosticSummaryViewModel => {
    const overview = props.controller.getSourceOverview(sourceId);
    return sourceDiagnostic(
      sourceId,
      overview.health?.state ?? overview.source?.state,
      overview.detail,
      props.controller.getCatalogGeneration(sourceId),
      props.controller.getCatalogFreshness(sourceId),
    ) ?? {
      severity: 'warning',
      title: '来源解析详情',
      userMessage: '来源当前可用。',
      impact: [{ state: 'preserved', message: '当前来源状态没有阻止操作。' }],
      nextStep: '返回来源详情。',
      technical: {
        code: 'catalogSourceReady',
        stage: 'resolve-source',
        sourceId,
        ...(overview.detail?.requestedRef ? { requestedRef: overview.detail.requestedRef } : {}),
        ...(overview.detail?.resolvedCommit ? { resolvedCommit: overview.detail.resolvedCommit } : {}),
      },
    };
  };
  const moveBatchTargetPage = (total: number, pageRows: number, direction: -1 | 1): void => {
    const lastOffset = Math.max(0, total - 1);
    setBatchTargetOffset((value) => Math.min(
      lastOffset,
      Math.max(0, value + direction * pageRows),
    ));
  };
  const pluginListRowIds = (
    _mode: 'browse' | 'installed',
    items: PluginListItemViewModel[],
    _queryValue = query,
    _sourceUnavailable = false,
  ): string[] => {
    if (items.length === 0) return [];
    return items.map((item) => item.pluginId);
  };

  const go = (next: TuiRoute): void => {
    props.controller.updatePageContext({
      focusIndex: focus,
      scrollOffset,
      query,
      installFilter,
      sourceTabId: route.name === 'pluginList' ? route.sourceId ?? 'all' : undefined,
      focusedEntityId: route.name === 'pluginList'
        ? pluginRows[focus]?.pluginId
        : route.name === 'sourceList' ? props.controller.listSources()[focus]?.id : undefined,
    });
    props.controller.push(next);
    setFocus(0);
    setFocusZone('content');
    setPinnedActionFocus(0);
    setScrollOffset(0);
    setSearchFocus(false);
    if (next.name === 'pluginList') {
      setInstallFilter(next.mode === 'installed' ? 'installed' : 'all');
    }
    setShowTechnical(false);
    setActionError(undefined);
  };
  const toggleTechnical = (): void => {
    if (portableResultDetailOpen) setFocus(portableResultDetailReturnFocus.current);
    setPortableResultDetailOpen(false);
    setPortableResultDetailOffset(0);
    setShowTechnical((value) => !value);
    if (!(route.name === 'result' && snapshot.result
      && 'operationKind' in snapshot.result
      && snapshot.result.operationKind === 'portableInstall')) {
      setBatchTargetOffset(0);
    }
  };
  const restorePageContext = (): void => {
    const restoredFrame = props.controller.snapshot.router.current;
    const restored = restoredFrame.context;
    let restoredFocus = restored.focusIndex ?? 0;
    let itemCount: number | undefined;
    if (restoredFrame.route.name === 'pluginList') {
      const items = props.controller.listPlugins({
        mode: restoredFrame.route.mode,
        ...(restoredFrame.route.sourceId ? { sourceId: restoredFrame.route.sourceId } : {}),
        ...(restored.query ? { query: restored.query } : {}),
        installFilter: restored.installFilter ?? 'all',
      });
      const rowIds = pluginListRowIds(restoredFrame.route.mode, items, restored.query ?? '');
      const restoredEntityIndex = restored.focusedEntityId
        ? rowIds.indexOf(restored.focusedEntityId) : -1;
      itemCount = rowIds.length;
      restoredFocus = restoredEntityIndex >= 0
        ? restoredEntityIndex
        : Math.min(restoredFocus, Math.max(0, rowIds.length - 1));
    } else if (restoredFrame.route.name === 'sourceList') {
      const sources = props.controller.listSources();
      itemCount = sources.length + 3;
      const entityIndex = restored.focusedEntityId
        ? sources.findIndex((source) => source.id === restored.focusedEntityId)
        : -1;
      restoredFocus = entityIndex >= 0
        ? entityIndex
        : Math.min(restoredFocus, Math.max(0, itemCount - 1));
    }
    let restoredScroll = Math.min(restored.scrollOffset ?? 0, Math.max(0, (itemCount ?? 1) - 1));
    if (restoredFocus < restoredScroll) restoredScroll = restoredFocus;
    else if (restoredFocus >= restoredScroll + 4) restoredScroll = Math.max(0, restoredFocus - 3);
    setFocus(restoredFocus);
    setScrollOffset(restoredScroll);
    setQuery(restored.query ?? '');
    setInstallFilter(restored.installFilter ?? 'all');
    setSearchFocus(false);
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
  const moveBatchStage = (stage: BatchDraft['stage']): void => {
    const restored = batchDraft?.stageView?.[stage];
    setBatchDraft((current) => current ? {
      ...current,
      stage,
      stageView: {
        ...current.stageView,
        [current.stage]: { focusIndex: focus, scrollOffset },
      },
    } : current);
    setFocus(restored?.focusIndex ?? 0);
    setScrollOffset(restored?.scrollOffset ?? 0);
    setActionError(undefined);
  };
  const back = (): void => {
    if (route.name === 'sourceEdit'
      && sourceDraft
      && sourceDraft.owner === route.owner
      && sourceDraftChanges(sourceDraft).length === 0) setSourceDraft(undefined);
    if (route.name === 'sourceAdd'
      && route.returnToDraft
      && sourceDraft
      && sourceDraft.owner === route.owner
      && sourceDraftChanges(sourceDraft).length === 0) setSourceDraft(undefined);
    if (route.name === 'result') props.controller.leaveResult();
    else props.controller.back();
    restorePageContext();
    setFocusZone('content');
    setPinnedActionFocus(0);
    setActionError(undefined);
  };
  const acceptSourceFieldAndBack = (): void => {
    props.controller.back();
    restorePageContext();
    setActionError(undefined);
  };
  const showSafeUiFailure = (error: unknown, code: string, stage: string): void => {
    if (error instanceof Error && error.name === 'AbortError') return;
    const recordId = props.controller.recordUiFailure(error, { code, stage });
    go({ name: 'operationDiagnostic', recordId });
  };
  const leaveResult = (target?: TuiRoute): void => {
    props.controller.leaveResult(target);
    restorePageContext();
    setShowTechnical(false);
    setActionError(undefined);
  };
  const beginReview = (intent: OperationIntent, returnRoute?: TuiRoute): void => {
    pendingReviewIntentRef.current = intent;
    setPendingReviewIntent(intent);
    const underlyingResultRoute = returnRoute ?? (route.name === 'result' && snapshot.result && 'returnRoute' in snapshot.result
      ? snapshot.result.returnRoute
      : undefined);
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
  useEffect(() => {
    if (route.name !== 'pluginWriteTask' || route.goal !== 'restore') return;
    if (snapshot.router.current.context.autoPreparedRestore) return;
    const retainedTargetKeys = route.targetKeys ? new Set(route.targetKeys) : undefined;
    const allCandidates = props.controller.listPluginWriteTaskCandidates('restore');
    const currentTargetKeys = new Set(allCandidates.map(pluginWriteTaskTargetKey));
    if (route.targetKeys?.some((targetKey) => !currentTargetKeys.has(targetKey))) return;
    const candidates = allCandidates
      .filter((candidate) => retainedTargetKeys
        ? retainedTargetKeys.has(pluginWriteTaskTargetKey(candidate))
        : candidate.target.pluginId === route.pluginId);
    if (candidates.length === 0 || candidates.some((candidate) => !candidate.eligible)) return;
    props.controller.updatePageContext({ autoPreparedRestore: true });
    beginReview({
      kind: 'pluginWriteTask',
      goal: 'restore',
      targets: candidates.map((candidate) => candidate.target),
      executionPolicy: 'all',
    }, props.controller.pluginWriteTaskReturnRoute(route));
  }, [
    props.controller,
    route.name,
    route.name === 'pluginWriteTask' ? route.goal : '',
    route.name === 'pluginWriteTask' ? route.pluginId : '',
    route.name === 'pluginWriteTask' ? route.targetKeys?.join('\0') ?? '' : '',
    snapshot.router.current.context.autoPreparedRestore,
    snapshot.viewModel,
  ]);
  const openBatchSelection = (action?: BatchPluginWriteAction): void => {
    props.controller.updatePageContext({
      focusIndex: focus,
      scrollOffset,
      query,
      installFilter,
      sourceTabId: route.name === 'pluginList' ? route.sourceId ?? 'all' : undefined,
      focusedEntityId: route.name === 'pluginList' ? pluginRows[focus]?.pluginId : undefined,
    });
    props.controller.beginPluginWriteBatch();
    const flowId = props.controller.snapshot.router.currentFlowId;
    if (!flowId) throw new Error('批量插件流程缺少 flowId。');
    setBatchDraft({
      flowId,
      ...(action ? { action } : {}),
      mode: route.name === 'pluginList' ? route.mode : action === 'install' ? 'browse' : 'installed',
      stage: 'select',
      selection: 'selected',
      selectedPluginIds: [],
      platform: 'both',
      scope: 'project',
      ...(route.name === 'pluginList' && route.sourceId ? { sourceId: route.sourceId } : {}),
      query,
      installFilter,
      showSelected: false,
    });
    setDirty(true);
    setFocus(0);
    setScrollOffset(0);
    setSearchFocus(false);
  };
  const batchCandidates = (draft: BatchDraft): BatchSelectionCandidate[] => {
    const mode = draft.mode;
    const frozenPluginIds = draft.frozenPluginIds ? new Set(draft.frozenPluginIds) : undefined;
    const all = props.controller.listPlugins({ mode })
      .filter((candidate) => !frozenPluginIds || frozenPluginIds.has(candidate.pluginId));
    if (draft.showSelected) {
      const byId = new Map(all.map((candidate) => [candidate.pluginId, candidate]));
      return draft.selectedPluginIds.map((pluginId) => ({
        pluginId,
        ...(byId.get(pluginId) ? { plugin: byId.get(pluginId) } : {}),
      }));
    }
    return props.controller.listPlugins({
      mode,
      ...(draft.sourceId ? { sourceId: draft.sourceId } : {}),
      ...(draft.query ? { query: draft.query } : {}),
      installFilter: draft.installFilter,
    }).filter((plugin) => !frozenPluginIds || frozenPluginIds.has(plugin.pluginId))
      .map((plugin) => ({ pluginId: plugin.pluginId, plugin }));
  };
  const batchTaskPluginIds = new Set(batchDraft ? [
    ...props.controller.listPluginWriteTaskCandidates('update'),
    ...props.controller.listPluginWriteTaskCandidates('restore'),
  ].map((entry) => entry.target.pluginId) : []);
  const batchCandidateBlockReason = (
    draft: BatchDraft,
    candidate: BatchSelectionCandidate,
  ): string | undefined => !candidate.plugin
    ? '插件已不在当前状态中，可取消选择'
    : draft.action === undefined
      && !props.controller.pluginHasInstallableTarget(candidate.plugin.pluginId)
      && props.controller.listPluginWriteBatchTargets(
        'uninstall', [candidate.plugin.pluginId],
      ).length === 0
      && !batchTaskPluginIds.has(candidate.plugin.pluginId)
      ? '没有可用于批量处理的实际目标'
    : draft.action === 'install' && candidate.plugin.configOnly
    ? '来源中没有可信插件定义'
    : draft.action === 'install' && candidate.plugin.sourceUnavailable
      ? '插件来源不可用'
      : draft.action === 'install' && candidate.plugin.capabilityUnsupported
        ? '当前 AW CLI 不支持插件所需功能'
        : draft.action === 'install' && !props.controller.pluginHasInstallableTarget(candidate.plugin.pluginId)
          ? '没有可信且兼容的缺失位置'
          : undefined;
  const invalidBatchSelection = (draft: BatchDraft): string[] => {
    const frozenPluginIds = draft.frozenPluginIds ? new Set(draft.frozenPluginIds) : undefined;
    const byId = new Map(props.controller.listPlugins({ mode: draft.mode })
      .filter((plugin) => !frozenPluginIds || frozenPluginIds.has(plugin.pluginId))
      .map((plugin) => [plugin.pluginId, plugin]));
    return draft.selectedPluginIds.filter((pluginId) => batchCandidateBlockReason(draft, {
      pluginId,
      ...(byId.get(pluginId) ? { plugin: byId.get(pluginId) } : {}),
    }) !== undefined);
  };
  const persistUnifiedDependencyGraphContext = (
    pluginId: string,
    projection: ReturnType<typeof buildUnifiedDependencyGraphProjection>,
    expandedPluginIds: ReadonlySet<string>,
    focusIndex: number,
    offset: number,
  ): void => {
    const actionIds = unifiedDependencyGraphActionIds(projection);
    dependencyGraphContexts.current.set(
      dependencyGraphContextKey(pluginId, 'dependencies'),
      {
        expandedPluginIds: new Set(expandedPluginIds),
        ...(actionIds[focusIndex] ? { focusedActionId: actionIds[focusIndex] } : {}),
        ...(actionIds[offset] ? { scrollAnchorActionId: actionIds[offset] } : {}),
      },
    );
  };
  const toggleBatchPlugin = (pluginId: string): void => {
    setBatchDraft((current) => current ? {
      ...current,
      selectedPluginIds: current.selectedPluginIds.includes(pluginId)
        ? current.selectedPluginIds.filter((candidate) => candidate !== pluginId)
        : [...current.selectedPluginIds, pluginId],
    } : current);
  };
  const prepareCurrentProjectPlugins = (): void => {
    if (props.controller.listCurrentProjectIntentRoots().length === 0) {
      setActionError('当前项目没有已保存的插件清单。');
      return;
    }
    beginReview({
      kind: 'pluginWriteBatch',
      action: 'sync',
      selection: { kind: 'currentProjectIntentRoots' },
      platform: 'both',
      scope: 'project',
    });
  };
  const prepareCurrentProjectTargets = (targets: PluginWriteBatchTarget[]): void => {
    if (targets.length === 0) {
      setActionError('当前项目没有已确认可同步的目标。');
      return;
    }
    beginReview({
      kind: 'pluginWriteBatch',
      action: 'sync',
      selection: {
        kind: 'currentProjectIntentTargets',
        targets: targets.map((target) => ({
          pluginId: target.pluginId,
          platform: target.platform,
          scope: target.scope,
        })),
      },
      platform: new Set(targets.map((target) => target.platform)).size > 1
        ? 'both' : targets[0]!.platform,
      scope: 'project',
    });
  };
  const openSelectedPluginTask = (
    goal: PluginWriteTaskGoal,
    pluginIds: string[],
    scopeConstraint?: Scope,
  ): void => {
    if (batchDraft && invalidBatchSelection(batchDraft).length > 0) {
      setActionError('已选插件状态已变化。请返回选择页检查并取消失效项。');
      return;
    }
    const selected = new Set(pluginIds);
    const candidates = props.controller.listPluginWriteTaskCandidates(goal)
      .filter((candidate) => selected.has(candidate.target.pluginId)
        && (!scopeConstraint || candidate.target.scope === scopeConstraint));
    const first = candidates[0];
    if (!first) {
      setActionError(goal === 'update'
        ? '所选插件没有经过版本证据确认的更新。'
        : '所选插件没有可恢复的现有位置。');
      return;
    }
    go({
      name: 'pluginWriteTask',
      pluginId: first.target.pluginId,
      goal,
      targetKeys: candidates.map(pluginWriteTaskTargetKey),
      ...(batchDraft ? {
        batchOrigin: { flowId: batchDraft.flowId, owner: 'batch-write' as const },
      } : {}),
      ...(goal === 'update'
        ? { versionEvidence: Object.assign({}, ...[...selected].map((pluginId) => {
            const candidatePlugin = props.controller.getPluginOverview(pluginId);
            return candidatePlugin ? pluginWriteTaskVersionEvidence(
              candidatePlugin,
              candidates.filter((candidate) => candidate.target.pluginId === pluginId),
            ) : {};
          })),
          ...(batchDraft?.frozenPluginIds
            ? { recommendedPluginIds: batchDraft.selectedPluginIds.slice() }
            : {}) }
        : {}),
    });
  };
  const openRecommendedUpdateTask = (pluginIds: string[]): void => {
    props.controller.updatePageContext({
      focusIndex: focus,
      scrollOffset,
      query,
      installFilter,
      sourceTabId: route.name === 'pluginList' ? route.sourceId ?? 'all' : undefined,
      focusedEntityId: route.name === 'pluginList' ? pluginRows[focus]?.pluginId : undefined,
    });
    props.controller.beginPluginWriteBatch();
    const flowId = props.controller.snapshot.router.currentFlowId;
    if (!flowId) throw new Error('推荐更新流程缺少 flowId。');
    const frozenPluginIds = [...new Set(pluginIds)];
    setBatchDraft({
      flowId,
      recommendedGoal: 'update',
      mode: 'installed',
      stage: 'select',
      selection: 'selected',
      selectedPluginIds: frozenPluginIds.slice(),
      frozenPluginIds,
      platform: 'both',
      scope: 'project',
      ...(route.name === 'pluginList' && route.sourceId ? { sourceId: route.sourceId } : {}),
      query,
      installFilter,
      showSelected: false,
    });
    setDirty(true);
    const selected = new Set(frozenPluginIds);
    const candidates = props.controller.listPluginWriteTaskCandidates('update')
      .filter((candidate) => selected.has(candidate.target.pluginId));
    const first = candidates[0];
    if (!first) {
      setActionError('推荐插件没有经过版本证据确认的更新。');
      return;
    }
    const versionEvidence = Object.assign({}, ...frozenPluginIds.map((pluginId) => {
      const candidatePlugin = props.controller.getPluginOverview(pluginId);
      return candidatePlugin ? pluginWriteTaskVersionEvidence(
        candidatePlugin,
        candidates.filter((candidate) => candidate.target.pluginId === pluginId),
      ) : {};
    }));
    props.controller.push({
      name: 'pluginWriteTask',
      pluginId: first.target.pluginId,
      goal: 'update',
      targetKeys: candidates.map(pluginWriteTaskTargetKey),
      versionEvidence,
      recommendedPluginIds: frozenPluginIds,
      batchOrigin: { flowId, owner: 'batch-write' },
    });
    setFocus(0);
    setScrollOffset(0);
    setSearchFocus(false);
  };
  const beginPortable = async (pluginId: string): Promise<void> => {
    try {
      await props.controller.preparePortableInstall(
        pluginId,
        route.name === 'portableBlocker' ? 'replace' : 'push',
      );
      setFocus(0);
      setPortableSelectionView('all');
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
    setSelectedTargets([platform]);
    props.controller.beginInstallFlow(candidate.pluginId, selectedScope);
    props.controller.setInstallPlatforms([platform]);
    go({ name: 'installTargets', pluginId: candidate.pluginId });
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
  const beginRestrictedForceCleanup = async (
    pluginId: string,
    platform: PlatformName,
    selectedScope: Scope,
  ): Promise<void> => {
    const candidate = await props.controller.getForceCleanupCandidate(
      pluginId,
      platform,
      selectedScope,
    );
    if (!candidate) {
      setActionError('当前没有可安全确认的受限清理目标。不属于插件、被共用、符号链接和原生内容会保持不变。');
      return;
    }
    try {
      props.controller.startForceCleanupReview(candidate);
      setFocus(0);
      setScrollOffset(0);
      setActionError(undefined);
    } catch (error) {
      showSafeUiFailure(error, 'tuiForceCleanupReviewFailed', 'force-cleanup-review');
    }
  };
  const beginAddSource = (): void => {
    const owner = `source-add:${Date.now()}`;
    setSourceDraft({ owner, mode: 'add', sourceId: '', type: 'git', location: '', refPolicy: 'cliChannel', ref: '', subdir: '', autoCheck: true });
    setDirty(true);
    go({ name: 'sourceAdd', step: 'type', owner });
  };
  const beginIssueSourceAdd = (sourceId: string): void => {
    const owner = `source-readd:${sourceId}:${Date.now()}`;
    setSourceDraft({ owner, mode: 'add', sourceId, type: 'git', location: '', refPolicy: 'cliChannel', ref: '', subdir: '', autoCheck: true });
    setDirty(true);
    go({ name: 'sourceAdd', step: 'type', owner });
  };
  const issueWriteIntent = (
    selectedIssue: UserIssueViewModel,
    action: UserIssueActionViewModel,
  ): OperationIntent | undefined => {
    const pluginId = action.pluginId ?? selectedIssue.pluginId;
    if (!pluginId) return undefined;
    const selectedScope = action.id === 'keepUserScope'
      ? 'project'
      : action.id === 'keepProjectScope' ? 'user' : action.scope ?? selectedIssue.scope;
    const selectedPlatform = action.platform ?? selectedIssue.platform;
    const dependencyIssue = selectedIssue.category === 'dependencyMissing'
      || selectedIssue.category === 'dependencyNotReady';
    const dependencyTargetAction = action.id === 'installDependency'
      || action.id === 'reinstallDependency';
    const sourceTargetCleanup = selectedIssue.entity.kind === 'source'
      && action.id === 'cleanup'
      && action.pluginId !== undefined
      && action.platform !== undefined
      && action.scope !== undefined;
    const targetSpecificOrigin = (dependencyIssue && !dependencyTargetAction)
      || sourceTargetCleanup;
    const consumerPluginId = targetSpecificOrigin
      ? pluginId : selectedIssue.pluginId;
    const consumerPlatform = targetSpecificOrigin
      ? selectedPlatform : selectedIssue.platform;
    const consumerScope = targetSpecificOrigin
      ? selectedScope : selectedIssue.scope;
    const writeAction = action.writeAction ?? (action.id === 'sync'
      ? 'sync'
      : action.id === 'refreshAndSync'
        ? 'refreshAndSync'
        : action.id === 'install'
          ? 'install'
          : action.id === 'reinstall'
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
        ...(targetSpecificOrigin
          ? {
              consumerPluginId,
              consumerSourceIdentity: consumerPluginId
                ? props.controller.getPluginSourceIdentity(consumerPluginId)
                : selectedIssue.sourceIdentity,
              consumerPlatform,
              consumerScope,
              ...(dependencyIssue ? {
                dependencyPluginId: selectedIssue.dependencyPluginId,
                dependencyPlatform: selectedIssue.dependencyPlatform,
                dependencyScope: selectedIssue.dependencyScope,
                dependencyProject: selectedIssue.dependencyProject,
              } : {}),
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
        ...(draft.autoCheck ? {} : { autoCheck: false }),
      }
    : {
        id: draft.sourceId,
        type: 'path',
        primary: false,
        path: draft.location,
        ...(draft.autoCheck ? {} : { autoCheck: false }),
      };
  const sourceDraftFromSource = (source: CatalogSource, owner: string): SourceDraft => source.type === 'git'
    ? {
        owner,
        mode: 'update',
        sourceId: source.id,
        type: 'git',
        location: source.url,
        refPolicy: source.refPolicy.type,
        ref: source.refPolicy.type === 'explicit' ? source.refPolicy.ref : '',
        subdir: source.subdir ?? '',
        autoCheck: source.autoCheck !== false,
      }
    : {
        owner,
        mode: 'update',
        sourceId: source.id,
        type: 'path',
        location: source.path,
        refPolicy: 'cliChannel',
        ref: '',
        subdir: '',
        autoCheck: source.autoCheck !== false,
      };
  const sourceUpdateFromDraft = (
    draft: SourceDraft,
  ): NonNullable<Extract<OperationIntent, { kind: 'sourceMutation' }>['update']> => draft.type === 'git'
    ? {
        type: 'git',
        url: draft.location,
        refPolicy: draft.refPolicy === 'cliChannel'
          ? { type: 'cliChannel' }
          : { type: 'explicit', ref: draft.ref },
        subdir: draft.subdir || null,
        autoCheck: draft.autoCheck,
      }
    : { type: 'path', path: draft.location, autoCheck: draft.autoCheck };
  const sourceDraftChanges = (draft: SourceDraft): Array<{ title: string; before?: string; after: string }> => {
    const current = draft.mode === 'update' ? props.controller.getConfiguredSource(draft.sourceId) : undefined;
    const location = (source: CatalogSource | undefined): string | undefined => source
      ? projectCatalogSourceLocation(source.type === 'git' ? source.url : source.path) : undefined;
    const rawLocation = (source: CatalogSource | undefined): string | undefined => source
      ? source.type === 'git' ? source.url : source.path : undefined;
    const ref = (source: CatalogSource | undefined): string | undefined => source?.type === 'git'
      ? source.refPolicy.type === 'cliChannel' ? '跟随 AW CLI' : source.refPolicy.ref
      : undefined;
    const candidates = [
      {
        title: draft.type === 'git' ? 'Git 仓库地址' : '本地目录',
        before: location(current),
        after: location(sourceFromDraft(draft))!,
        changed: rawLocation(current) !== draft.location,
      },
      ...(draft.type === 'git' ? [
        { title: '版本引用', before: ref(current), after: draft.refPolicy === 'cliChannel' ? '跟随 AW CLI' : draft.ref, changed: ref(current) !== (draft.refPolicy === 'cliChannel' ? '跟随 AW CLI' : draft.ref) },
        { title: 'Catalog 子目录', before: current?.type === 'git' ? current.subdir ?? '仓库根目录' : undefined, after: draft.subdir || '仓库根目录', changed: current?.type !== 'git' || (current.subdir ?? '') !== draft.subdir },
      ] : []),
      { title: '自动检查更新', before: current ? current.autoCheck !== false ? '开启' : '关闭' : undefined, after: draft.autoCheck ? '开启' : '关闭', changed: !current || (current.autoCheck !== false) !== draft.autoCheck },
    ];
    return candidates.filter((change) => change.changed)
      .map(({ changed: _changed, ...change }) => change);
  };
  const beginSourceReview = (draft: SourceDraft, activate: boolean): void => {
    const mutation = draft.mode === 'add'
      ? { action: 'add' as const, source: sourceFromDraft(draft) }
      : { action: 'update' as const, update: sourceUpdateFromDraft(draft) };
    if (activate) {
      beginReview({
        kind: 'catalogGeneration',
        action: 'activate',
        sourceId: draft.sourceId,
        sourceMutation: mutation,
      });
      return;
    }
    beginReview(draft.mode === 'add' ? {
      kind: 'sourceMutation',
      action: 'add',
      sourceId: draft.sourceId,
      source: mutation.action === 'add' ? mutation.source : undefined,
      changes: sourceDraftChanges(draft),
    } : {
      kind: 'sourceMutation',
      action: 'update',
      sourceId: draft.sourceId,
      update: mutation.action === 'update' ? mutation.update : undefined,
      changes: sourceDraftChanges(draft),
    });
  };
  const openSourceEdit = (sourceId: string): void => {
    const source = props.controller.getConfiguredSource(sourceId);
    if (!source) {
      setActionError('无法读取完整来源配置。请重新加载后重试。');
      return;
    }
    const owner = `source-update:${sourceId}:${Date.now()}`;
    setSourceDraft(sourceDraftFromSource(source, owner));
    setDirty(false);
    go({ name: 'sourceEdit', sourceId, owner });
  };
  const configLayerLabel = (layer: { scope: Scope | 'effective' }): string =>
    layer.scope === 'effective' ? '有效设置'
      : layer.scope === 'user' ? '个人默认'
        : '当前项目';
  const objectSummary = (field: ConfigFieldViewModel, value: PluginConfigObject): string => {
    if (field.sensitive) return '已设置';
    if (configObjectHasSensitiveChild(field.definition)) {
      const count = Object.keys(value).length;
      return `已设置 · ${count === 0 ? '空对象' : `${count} 项`}`;
    }
    const preset = field.choices?.find((choice) => configValuesEqual(choice.value, value));
    const keys = Object.keys(value).sort((left, right) => left.localeCompare(right, 'en'));
    const count = keys.length === 0
      ? '空对象'
      : `${keys.length} 项（${keys.slice(0, 2).join('、')}${keys.length > 2 ? '…' : ''}）`;
    return preset ? `方案“${preset.title}” · ${count}` : `自定义 · ${count}`;
  };
  const scalarSummary = (
    field: ConfigFieldViewModel,
    value: Exclude<PluginConfigValue, PluginConfigObject>,
  ): string => {
    if (field.sensitive) return '将更新';
    const preset = field.choices?.find((choice) => configValuesEqual(choice.value, value));
    if (preset) return preset.title;
    if (field.type === 'boolean') return value ? '开启' : '关闭';
    return `${String(value)}${field.unit ? ` ${field.unit}` : ''}`;
  };
  const currentFieldDisplay = (field: ConfigFieldViewModel): string => {
    if (draftRemoves.includes(field.key)) return '恢复继承';
    if (Object.hasOwn(draftUpdates, field.key)) {
      const value = draftUpdates[field.key];
      return typeof value === 'object'
        ? objectSummary(field, value)
        : scalarSummary(field, value);
    }
    if (field.type === 'boolean' && field.value !== undefined) return field.value ? '开启' : '关闭';
    return `${field.displayValue}${field.unit && field.displayValue !== '未设置' ? ` ${field.unit}` : ''}`;
  };
  const effectiveFieldDisplay = (field: ConfigFieldViewModel): string => {
    if (field.type === 'boolean' && field.effectiveValue !== undefined) {
      return field.effectiveValue ? '开启' : '关闭';
    }
    return `${field.effectiveDisplayValue}${field.unit && field.effectiveDisplayValue !== '未设置' ? ` ${field.unit}` : ''}`;
  };
  const pendingFieldDisplay = (field: ConfigFieldViewModel, scope: Scope): string | undefined => {
    const draft = configDrafts[scope];
    if (!draft) return undefined;
    if (draft.removes.includes(field.key)) return '将删除此位置的覆盖并恢复继承';
    if (!Object.hasOwn(draft.updates, field.key)) return undefined;
    const value = draft.updates[field.key]!;
    if (field.sensitive) return '将更新';
    return typeof value === 'object' ? objectSummary(field, value) : scalarSummary(field, value);
  };
  const pendingFieldTargets = (field: ConfigFieldViewModel): Array<{ scope: Scope; value: string }> =>
    (['project', 'user'] as const).flatMap((scope) => {
      const value = pendingFieldDisplay(field, scope);
      return value ? [{ scope, value }] : [];
    });
  const fieldEditor = (field: ConfigFieldViewModel): Extract<TuiRoute, { name: 'configFieldEditor' }>['editor'] => {
    return field.type;
  };
  const fieldEditorMode = (field: ConfigFieldViewModel): { mode: 'choices' } | Record<string, never> =>
    (field.choices?.length ?? 0) > 0 ? { mode: 'choices' } : {};
  const openConfigTarget = (candidate: ConfigCandidate): void => {
    const currentFlowId = snapshot.router.currentFlowId;
    const storedAnchor = configOverviewAnchors.current.get(candidate.pluginId);
    const storedOverviewFrameId = storedAnchor && storedAnchor.flowId === currentFlowId
      ? storedAnchor.overviewFrameId : undefined;
    const overviewFrameId = storedOverviewFrameId
      ?? props.controller.configOverviewFrameId(currentFlowId, candidate.pluginId);
    setConfigCandidate({
      ...candidate,
      ...(currentFlowId ? { flowId: currentFlowId } : {}),
      ...(overviewFrameId ? { overviewFrameId } : {}),
    });
    go({
      name: 'configLayer',
      pluginId: candidate.pluginId,
      ...(candidate.fieldKey ? { fieldKey: candidate.fieldKey } : {}),
      ...(candidate.groupId ? { groupId: candidate.groupId } : {}),
      ...(candidate.presetId ? { presetId: candidate.presetId } : {}),
    });
  };
  const updateDraft = (key: string, value: PluginConfigValue): void => {
    if (!configRoute || !currentConfigPage) return;
    setConfigActionError(undefined);
    openConfigTarget({
      pluginId: configRoute.pluginId,
      fieldKey: key,
      groupId: snapshot.router.current.context.configGroupId,
      mutations: { [key]: { kind: 'set', value } },
    });
  };
  const removeDraft = (key: string): void => {
    if (!configRoute) return;
    setConfigActionError(undefined);
    openConfigTarget({
      pluginId: configRoute.pluginId,
      fieldKey: key,
      groupId: snapshot.router.current.context.configGroupId,
      mutations: { [key]: { kind: 'unset' } },
    });
  };
  const updateObjectDraft = (value: PluginConfigObject): void => {
    if (!activeObjectKey) return;
    setObjectDrafts((current) => ({ ...current, [activeObjectKey]: value }));
    const initial = objectValueFromUpdate ?? objectValueFromField ?? {};
    setChangedObjectDraftKeys((current) => configValuesEqual(initial, value)
      ? current.filter((key) => key !== activeObjectKey)
      : [...new Set([...current, activeObjectKey])]);
    setObjectError(undefined);
    setConfigActionError(undefined);
  };
  const objectIssueText = (
    issue: ReturnType<typeof validatePluginConfigValue>[number],
  ): string => `${issue.path.property ?? issue.path.field}：${issue.message}`;
  const commitObjectDraft = (): void => {
    if (!activeField || activeField.definition.type !== 'object' || !activeObjectDraft) return;
    const issues = validatePluginConfigValue(activeField.definition, activeObjectDraft, activeField.key);
    if (issues.length > 0) {
      setObjectError(issues.slice(0, 2).map(objectIssueText).join('；'));
      return;
    }
    updateDraft(activeField.key, activeObjectDraft);
    if (activeObjectKey) {
      setChangedObjectDraftKeys((current) => current.filter((key) => key !== activeObjectKey));
    }
  };
  const objectPropertyStage = (
    definition: PluginConfigObjectPropertyField | PluginConfigAdditionalPropertiesField,
  ): Extract<TuiRoute, { name: 'configObjectPropertyEditor' }>['stage'] =>
    definition.type === 'boolean' || definition.choices ? 'choices' : 'custom';
  const openObjectProperty = (propertyKey: string, dynamic: boolean): void => {
    if (!activeField || activeField.definition.type !== 'object') return;
    const definition = activeField.definition.properties?.[propertyKey]
      ?? (activeField.definition.additionalProperties === false
        ? undefined
        : activeField.definition.additionalProperties);
    if (!definition) return;
    const exists = activeObjectDraft && Object.hasOwn(activeObjectDraft, propertyKey);
    go({
      name: 'configObjectPropertyEditor',
      pluginId: configRoute!.pluginId,
      layer: { scope: 'effective' },
      fieldKey: activeField.key,
      propertyKey,
      dynamic,
      stage: exists ? 'action' : objectPropertyStage(definition),
    });
  };
  const updateObjectProperty = (propertyKey: string, value: PluginConfigScalar): boolean => {
    if (!activeField || activeField.definition.type !== 'object' || !activeObjectDraft) return false;
    const candidate = { ...activeObjectDraft, [propertyKey]: value };
    const issues = validatePluginConfigValue(activeField.definition, candidate, activeField.key)
      .filter((issue) => issue.path.property === propertyKey);
    if (issues.length > 0) {
      setInputError(issues.slice(0, 2).map(objectIssueText).join('；'));
      return false;
    }
    updateObjectDraft(candidate);
    return true;
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
    const mutations = Object.fromEntries(Object.entries(preset.values).flatMap(([key, value]) =>
      fields.has(key) ? [[key, { kind: 'set' as const, value }]] : []));
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
    openConfigTarget({
      pluginId: page.pluginId,
      presetId,
      groupId: target?.groupId,
      mutations,
    });
  };
  const openConfigLayerTarget = (
    layer: { scope: Scope },
  ): void => {
    if (route.name !== 'configLayer') return;
    if (!configCandidate || configCandidate.pluginId !== route.pluginId) return;
    const page = configLayerPages[layer.scope];
    if (!page) return;
    const fields = new Map(page.groups.flatMap((group) => group.fields)
      .map((field) => [field.key, field]));
    const valid = Object.entries(configCandidate.mutations).every(([key, mutation]) => {
      const field = fields.get(key);
      return Boolean(field && (mutation.kind === 'set' ? configFieldCanSet(field) : configFieldCanUnset(field)));
    });
    if (!valid) {
      setConfigActionError('此值不能保存到所选位置。请返回修改值或选择其他位置。');
      return;
    }
    const previous = configDrafts[layer.scope] ?? { updates: {}, removes: [] };
    const updates = { ...previous.updates };
    const removes = new Set(previous.removes);
    for (const [key, mutation] of Object.entries(configCandidate.mutations)) {
      const field = fields.get(key)!;
      if (mutation.kind === 'set') {
        removes.delete(key);
        if (field.configured && configValuesEqual(field.draftValue ?? field.value, mutation.value)) {
          delete updates[key];
        } else updates[key] = mutation.value;
      } else {
        delete updates[key];
        if (field.configured) removes.add(key);
        else removes.delete(key);
      }
    }
    const next = { ...configDrafts, [layer.scope]: { updates, removes: [...removes] } };
    if (Object.keys(updates).length === 0 && removes.size === 0) delete next[layer.scope];
    const target = configCandidate.fieldKey
      ? configFieldTarget(configPage ?? page, configCandidate.fieldKey)
      : configCandidate.groupId ? { groupId: configCandidate.groupId, focusIndex: 0 } : undefined;
    const returned = props.controller.returnToConfigOverview(
      configCandidate.flowId,
      configCandidate.overviewFrameId,
      route.pluginId,
      target ? { configGroupId: target.groupId, focusIndex: target.focusIndex, scrollOffset: 0 } : undefined,
    );
    if (!returned) {
      setConfigActionError('设置总览已变化。请返回插件详情后重新打开设置。');
      return;
    }
    if (!configCandidate.flowId) {
      props.controller.replace(
        { name: 'configFields', pluginId: route.pluginId, layer: { scope: 'effective' } },
        target ? { configGroupId: target.groupId, focusIndex: target.focusIndex, scrollOffset: 0 } : undefined,
      );
    }
    setConfigDrafts(next);
    setDirty(Object.keys(next).length > 0);
    setConfigCandidate(undefined);
    setFocus(target?.focusIndex ?? 0);
    setScrollOffset(0);
  };
  const configChanges = (
    page: ConfigPageViewModel,
    draft: ConfigLayerDraft,
  ): NonNullable<Extract<OperationIntent, { kind: 'configSaveBatch' }>['groups'][number]['changes']> => {
    const fields = page.groups.flatMap((group) => group.fields);
    return [...Object.keys(draft.updates), ...draft.removes.filter((key) => !Object.hasOwn(draft.updates, key))]
      .map((key) => {
        const field = fields.find((candidate) => candidate.key === key)!;
        const beforeObject = field?.definition.type === 'object'
          && typeof field.draftValue === 'object' ? field.draftValue : undefined;
        const updatedValue = draft.updates[key];
        const afterObject = field?.definition.type === 'object'
          && typeof updatedValue === 'object' ? updatedValue : undefined;
        const childSummary = (property: string, value: PluginConfigScalar | undefined): string => {
          if (value === undefined) return '未设置';
          if (field.sensitive || field.definition.type !== 'object') return '已设置';
          const definition = field.definition.properties?.[property]
            ?? (field.definition.additionalProperties === false
              ? undefined
              : field.definition.additionalProperties);
          if (definition?.sensitive) return '已设置';
          if (typeof value === 'boolean') return value ? '开启' : '关闭';
          return String(value);
        };
        const updatedChildren = beforeObject && afterObject
          ? [...new Set([...Object.keys(beforeObject), ...Object.keys(afterObject)])]
              .sort((left, right) => {
                const fixed = field.definition.type === 'object'
                  ? Object.keys(field.definition.properties ?? {}) : [];
                const leftIndex = fixed.indexOf(left);
                const rightIndex = fixed.indexOf(right);
                if (leftIndex >= 0 || rightIndex >= 0) {
                  if (leftIndex < 0) return 1;
                  if (rightIndex < 0) return -1;
                  return leftIndex - rightIndex;
                }
                return left.localeCompare(right, 'en');
              })
              .filter((property) => beforeObject[property] !== afterObject[property])
              .map((property) => {
                const definition = field.definition.type === 'object'
                  ? field.definition.properties?.[property]
                    ?? (field.definition.additionalProperties === false
                      ? undefined
                      : field.definition.additionalProperties)
                  : undefined;
                return {
                  property,
                  before: childSummary(property, beforeObject[property]),
                  after: childSummary(property, afterObject[property]),
                  ...(field.sensitive || definition?.sensitive ? { private: true } : {}),
                };
              })
          : undefined;
        const children = draft.removes.includes(key)
          ? field.fallbackObjectChanges
          : updatedChildren;
        const after = draft.removes.includes(key)
          ? `恢复继承（${field?.fallbackDisplayValue ?? '未设置'} · ${field?.fallbackSourceLabel ?? '未设置'}）`
          : updatedValue && typeof updatedValue === 'object'
            ? objectSummary(field, updatedValue)
            : scalarSummary(field, updatedValue as Exclude<PluginConfigValue, PluginConfigObject>);
        return {
          key,
          title: field?.title ?? key,
          before: field?.displayValue ?? '未设置',
          after,
          ...(children && children.length > 0 ? { children } : {}),
        };
      });
  };
  const discardInvalidConfigDraftChanges = (): void => {
    if (!configRoute || configDraftIssues.length === 0) return;
    const invalidKeys = new Set(configDraftIssues.map((issue) => issue.key));
    const nextDrafts = Object.fromEntries((['project', 'user'] as const).flatMap((scope) => {
      const draft = configDrafts[scope];
      if (!draft) return [];
      const invalidForScope = new Set(configDraftIssues
        .filter((issue) => issue.scope === scope).map((issue) => issue.key));
      const updates = Object.fromEntries(Object.entries(draft.updates)
        .filter(([key]) => !invalidForScope.has(key)));
      const removes = draft.removes.filter((key) => !invalidForScope.has(key));
      return Object.keys(updates).length + removes.length > 0 ? [[scope, { updates, removes }]] : [];
    })) as Partial<Record<Scope, ConfigLayerDraft>>;
    const owner = `${configOwnerKey(configRoute)}\0`;
    const nextChangedObjectKeys = changedObjectDraftKeys.filter((key) => !key.startsWith(owner)
      || !invalidKeys.has(key.slice(owner.length)));
    setConfigDrafts(nextDrafts);
    setObjectDrafts((current) => Object.fromEntries(Object.entries(current)
      .filter(([key]) => !key.startsWith(owner)
        || !invalidKeys.has(key.slice(owner.length)))));
    setChangedObjectDraftKeys(nextChangedObjectKeys);
    setDirty(Object.keys(nextDrafts).length + nextChangedObjectKeys.length > 0);
    setObjectError(undefined);
    setConfigActionError(undefined);
  };
  const configSaveIntent = (
    apply: boolean,
  ): Extract<OperationIntent, { kind: 'configSaveBatch' }> | undefined => {
    if (!configRoute || configDraftCount === 0) return;
    const groups = (['project', 'user'] as const).flatMap((scope) => {
      const draft = configDrafts[scope];
      const page = configLayerPages[scope];
      if (!draft || !page) return [];
      const fields = page.groups.flatMap((group) => group.fields);
      return [{
        scope,
        updates: draft.updates,
        removeKeys: draft.removes,
        sensitiveKeys: fields.filter((field) => field.sensitive).map((field) => field.key),
        privateKeys: fields.filter((field) => configObjectHasSensitiveChild(field.definition))
          .map((field) => field.key),
        changes: configChanges(page, draft),
      }];
    });
    if (groups.length !== Object.keys(configDrafts).length || groups.length === 0) return;
    return {
      kind: 'configSaveBatch',
      pluginId: configRoute.pluginId,
      apply,
      groups,
    };
  };
  const beginConfigSave = async (apply: boolean): Promise<void> => {
    if (configDraftIssues.length > 0) {
      setConfigActionError('字段已变化。请先放弃失效草稿，或返回继续检查来源。');
      return;
    }
    const intent = configSaveIntent(apply);
    if (!intent) return;
    try {
      await beginReview(intent);
      setConfigActionError(undefined);
    } catch (error) {
      props.controller.recordUiFailure(error, { code: 'tuiConfigReviewFailed', stage: 'config-review' });
      setConfigActionError('设置值未通过验证。请重新检查修改。');
    }
  };
  useEffect(() => {
    if (!operationConfirmation) return;
    if (route.name !== 'review'
      || snapshot.activeReview?.reviewToken !== operationConfirmation.reviewToken) {
      setOperationConfirmation(undefined);
      setOverlayFocus(0);
    }
  }, [operationConfirmation, route.name, snapshot.activeReview?.reviewToken]);

  if (snapshot.phase === 'error' && !isCatalogSourcesBootstrapFlow(snapshot)
    && !isOperationHistoryRoute(route)) {
    const sourcesConfigInvalid = snapshot.loadError?.code === 'catalogSourcesConfigInvalid';
    breadcrumb = sourcesConfigInvalid ? 'Catalog 来源恢复' : '启动失败';
    title = sourcesConfigInvalid ? 'Catalog 来源配置损坏' : '无法读取插件状态';
    description = sourcesConfigInvalid
      ? '来源配置无法安全读取。可以先备份原文件，再恢复官方默认来源。'
      : snapshot.loadError?.message ?? '当前不能安全显示插件状态。';
    help = sourcesConfigInvalid
      ? '↑↓ 移动 · Enter 选择 · d 技术详情 · q 退出'
      : 'd 技术详情 · q 退出 · Ctrl-C 退出';
    actions = sourcesConfigInvalid ? [{
      label: '备份并恢复官方默认来源',
      description: '先进入确认页；不会删除目录版本状态或本地缓存',
      run: () => beginReview({ kind: 'catalogSourcesRecovery' }),
    }] : [];
    content = <Box flexDirection="column">
      <StatusCard status="error" title="插件状态无法读取" description="没有执行任何写操作。" />
      {actions.length > 0 ? <SemanticRows actions={actions} focus={focus} kind="action" compact={policy.mode === 'compact'} /> : null}
      {showTechnical ? <TechnicalDetails><StaticRow title="安全诊断" meta={snapshot.loadError?.code ?? 'statusLoadFailed'} compact /></TechnicalDetails> : null}
    </Box>;
  } else if (snapshot.phase !== 'ready' && !isCatalogSourcesBootstrapFlow(snapshot)
    && !isOperationHistoryRoute(route)) {
    breadcrumb = '启动';
    title = '正在检查插件状态';
    description = '单个来源失败不会阻止其他来源继续加载。';
    help = 'Ctrl-C 退出';
    content = <StatusCard status="info" title="准备控制台">
      <ProgressRow title="读取插件来源" state="active" />
      <ProgressRow title="检查当前项目" state="pending" />
      <ProgressRow title="汇总可用操作" state="pending" />
    </StatusCard>;
  } else if (rendererFamily === 'home' && route.name === 'home') {
    const home = snapshot.viewModel!.home;
    const projectReminder = snapshot.projectIntentReminder;
    const projectIntentIssue = snapshot.projectIntentIssue;
    const projectPendingCount = (projectReminder?.actionableTargets.length ?? 0)
      + (projectReminder?.blockedTargets.length ?? 0);
    const projectTargetCount = projectPendingCount + (projectReminder?.unconfirmedTargets.length ?? 0);
    context = '当前项目';
    actions = [
      ...(projectIntentIssue ? [{
        actionId: 'project-intent-issue',
        label: projectIntentIssue.state === 'invalid'
          ? '本项目插件声明无效'
          : '无法读取本项目插件声明',
        description: projectIntentIssue.state === 'invalid'
          ? '本项目插件声明无效；修复后重新加载'
          : '无法读取本项目插件声明；检查项目位置或权限后重新加载',
        status: 'warning' as const,
        run: () => go({ name: 'projectStatus' }),
      }] : []),
      ...(projectTargetCount > 0 ? [{
        label: '项目插件',
        description: projectReminder!.actionableTargets.length > 0
          ? `${projectReminder!.actionableTargets.length} 个位置可同步；`
            + `${projectReminder!.blockedTargets.length} 个位置需要先处理；`
            + `${projectReminder!.unconfirmedTargets.length} 个位置未确认`
          : projectReminder!.blockedTargets.length > 0
            ? `${projectReminder!.blockedTargets.length} 个位置需要先处理；`
              + `${projectReminder!.unconfirmedTargets.length} 个位置未确认`
            : `${projectReminder!.unconfirmedTargets.length} 个位置未确认`,
        meta: String(projectTargetCount),
        status: 'warning' as const,
        run: () => go({ name: 'projectStatus' }),
      }] : []),
      { label: '插件', description: '浏览、安装和管理所有插件', meta: `${home.installedPlugins} 已安装`, status: home.pluginUpdateCount > 0 ? 'warning' : undefined, run: () => go({ name: 'pluginList', mode: 'browse' }) },
      { label: '需要处理', description: '解决安装、来源或设置问题', meta: String(home.issueCount), status: 'warning', run: () => go({ name: 'issueList' }) },
      {
        label: '插件来源',
        description: '管理 Git 仓库和本地目录',
        meta: home.catalogUpdateCount > 0 ? `${home.catalogUpdateCount} 个更新`
          : home.catalogCheckingCount > 0 ? `${home.catalogCheckingCount} 个检查中`
            : home.catalogRecoveryCount > 0 ? `${home.catalogRecoveryCount} 个需处理` : String(home.sourceCount),
        status: home.catalogUpdateCount > 0 || home.catalogRecoveryCount > 0 ? 'warning' : undefined,
        run: () => go({ name: 'sourceList' }),
      },
    ];
    const homeViewport = rowViewport({
      rowHeights: actions.map((action) => showTechnical ? 1 : objectCardRowLayout({
        description: action.description ?? '', meta: action.meta, width: size.columns - 2,
        compact: policy.mode === 'compact',
      }).height), focus, requestedOffset: scrollOffset, rowBudget: pageActionBudget(showTechnical ? 7 : 2),
    });
    content = <Box flexDirection="column">
      <Text color={tuiTheme.colors.muted}>[已安装 {home.installedPlugins}] [可更新 {home.pluginUpdateCount}]
        {home.unavailableSourceCount > 0 ? ` [不可用来源 ${home.unavailableSourceCount}]` : ''}</Text>
      <Text color={tuiTheme.colors.muted}>{projectIntentIssue ? '! 本项目插件声明需要检查'
        : projectReminder && projectReminder.unconfirmedTargets.length > 0
          ? '? 部分项目插件状态无法确认' : projectPendingCount > 0
            ? `! ${projectPendingCount} 个位置待处理`
            : snapshot.projectDeclarationAbsent
              ? '当前目录没有共享插件声明；不会自动安装插件' : '没有待同步提醒'}</Text>
      {projectIntentIssue && showTechnical ? <TechnicalDetails title="项目声明诊断" compact>
        <StaticRow title="错误代码" meta={projectIntentIssue.code} compact />
        <StaticRow title="说明" meta={sanitizeDiagnosticText(projectIntentIssue.message)} compact />
      </TechnicalDetails> : null}
      <SemanticRows actions={actions} focus={projectReminderOpen ? -1 : focus} kind="task" cards={!showTechnical} columns={size.columns - 2}
        compact={policy.mode === 'compact'} offset={homeViewport.offset} limit={homeViewport.limit} />
    </Box>;
  } else if (route.name === 'projectStatus') {
    const reminder = snapshot.projectIntentReminder;
    const projectIntentIssue = snapshot.projectIntentIssue;
    const actionable = reminder?.actionableTargets ?? [];
    const blocked = reminder?.blockedTargets ?? [];
    const unconfirmed = reminder?.unconfirmedTargets ?? [];
    const allTargets = [
      ...actionable.map((target) => ({ target, state: 'actionable' as const })),
      ...blocked.map((target) => ({ target, state: 'blocked' as const })),
      ...unconfirmed.map((target) => ({ target, state: 'unconfirmed' as const })),
    ];
    const pluginCount = new Set(allTargets.map(({ target }) => target.pluginId)).size;
    const sourceLabel = (pluginId: string): string => pluginId.split('/')[0] ?? pluginId;
    const isSourceBlocker = (reasonCodes: readonly string[]): boolean => reasonCodes.some((code) =>
      code === 'catalogSourceUnavailable' || code === 'sourceUnavailable'
      || code === 'catalogSourceMissing' || code === 'sourceMissing' || code === 'bundleUnavailable'
      || code === 'codexIntentSourceUnavailable' || code === 'sourceChanged');
    const sourceBlockedCount = blocked.filter((target) => isSourceBlocker(target.reasonCodes)).length;
    const reasonLabel = (reasonCodes: readonly string[], state: 'actionable' | 'blocked' | 'unconfirmed'): string => {
      if (reasonCodes.includes('sourceChanged')) return '来源身份已变化';
      if (reasonCodes.includes('sourceMissing')) return '来源已移除';
      if (reasonCodes.includes('bundleUnavailable')) return '当前来源目录没有此插件';
      if (isSourceBlocker(reasonCodes)) return '来源当前不可用';
      if (reasonCodes.includes('awCapabilityUnsupported')) return '当前 AW 不支持所需能力';
      if (reasonCodes.includes('codexExtensionScopeConflict')) return '使用位置冲突';
      if (reasonCodes.includes('artifactCollision')) return '输出内容冲突';
      if (reasonCodes.includes('codexSharedNativeForeign')) return '共享位置存在非本插件内容';
      if (reasonCodes.some((code) => code === 'codexSharedNativeUnobserved'
        || code === 'codexNativeObservationFailed')) return '平台状态未确认';
      if (state === 'actionable') return '已确认需要同步';
      if (state === 'blocked') return '当前目标受阻';
      return '当前状态未确认';
    };
    breadcrumb = '需要处理 / 本项目';
    title = projectIntentIssue || unconfirmed.length > 0
      ? '尚未确认项目插件状态'
      : blocked.length > 0 ? '部分项目插件需要先处理'
        : allTargets.length === 0 ? '项目插件状态已检查' : '项目共享插件';
    description = projectIntentIssue
      ? projectIntentIssue.state === 'invalid'
        ? '本项目插件声明无效。修复声明后重新检查。'
        : '读取本项目插件声明失败。当前不会执行安装或恢复。'
      : allTargets.length === 0
        ? '当前没有待同步或待检查的项目插件位置。'
        : `${pluginCount} 个插件涉及 ${allTargets.length} 个位置：`
          + `${actionable.length} 个可同步 · ${blocked.length} 个受阻 · ${unconfirmed.length} 个未确认`;
    context = allTargets.length > 0 ? `${pluginCount} 个插件 · ${allTargets.length} 个位置` : '当前项目';
    actions = allTargets.map(({ target, state }) => {
      const overview = props.controller.getPluginOverview(target.pluginId);
      const status = state === 'actionable' ? 'warning' as const
        : state === 'blocked' ? 'error' as const : 'muted' as const;
      const symbol = state === 'actionable' ? '!' as const : state === 'blocked' ? '!' as const : '?' as const;
      return {
        actionId: `project-target:${target.pluginId}:${target.platform}:${target.scope}`,
        label: overview?.displayName ?? target.pluginId.split('/').at(-1) ?? target.pluginId,
        description: `${platformLabel(target.platform)} · 当前项目 · ${reasonLabel(target.reasonCodes, state)}`,
        meta: `来源 ${sourceLabel(target.pluginId)} · 项目共享声明`,
        tags: <StatusBadge items={[{
          key: state,
          label: state === 'actionable' ? '待同步' : state === 'blocked' ? '需处理' : '未确认',
          symbol,
          status,
        }]} />,
        status,
        run: state === 'blocked' && isSourceBlocker(target.reasonCodes)
          ? () => {
            const sourceId = sourceLabel(target.pluginId);
            go(props.controller.getSourceOverview(sourceId).source
              ? { name: 'sourceDetail', sourceId } : { name: 'sourceList' });
          }
          : state === 'unconfirmed' || !overview ? () => setShowTechnical(true)
            : () => go({ name: 'pluginDetail', pluginId: target.pluginId }),
      };
    });
    pinnedActions = [
      ...(actionable.length > 0 ? [{
        actionId: 'project-sync-actionable',
        label: `同步明确的 ${actionable.length} 个位置`,
        description: blocked.length + unconfirmed.length > 0
          ? `保留 ${blocked.length} 个受阻位置和 ${unconfirmed.length} 个未确认位置；进入现有操作汇总后再确认`
          : '进入现有操作汇总后再确认',
        run: () => prepareCurrentProjectTargets(actionable),
      }] : []),
      ...(sourceBlockedCount > 0 ? [{
        actionId: 'project-open-sources',
        label: '处理插件来源',
        description: `${sourceBlockedCount} 个位置需要先处理来源问题`,
        run: () => go({ name: 'sourceList' }),
      }] : []),
      {
        actionId: 'project-recheck',
        label: '重新检查',
        description: '重新读取项目声明和平台状态；不会自动安装或恢复',
        run: () => requestSessionNavigation('reload'),
      },
      ...(projectIntentIssue || blocked.length > 0 || unconfirmed.length > 0 ? [{
        actionId: 'project-error-details',
        label: '错误详情',
        description: '查看现有安全错误代码和诊断，不执行写操作',
        run: () => setShowTechnical((value) => !value),
      }] : []),
      {
        actionId: 'project-back-home',
        label: '返回首页',
        run: back,
      },
    ];
    help = showTechnical
      ? 'p/n 或 PgUp/PgDn 阅读 · d 返回项目位置 · Tab 固定操作 · Esc 返回'
      : focusZone === 'actions'
        ? '←→ 移动固定操作 · Enter 选择 · Tab 返回项目位置 · Esc 返回'
        : '↑↓ 移动 · Enter 查看 · Tab 固定操作 · Esc 返回';
    const viewport = rowViewport({
      rowHeights: actions.map((action) => objectCardRowLayout({
        description: action.description ?? '', meta: action.meta,
        width: size.columns - 2, hasTags: true, compact: policy.mode === 'compact',
      }).height),
      focus,
      requestedOffset: scrollOffset,
      rowBudget: pageActionBudget(showTechnical ? 5
        : 1 + (projectIntentIssue || unconfirmed.length > 0 ? 1 : 0)
          + (actionable.length > 0 && blocked.length + unconfirmed.length > 0 ? 1 : 0)),
    });
    const technicalLines = [
      ...(projectIntentIssue ? [
        `项目声明 · ${safeDiagnosticCode(projectIntentIssue.code, 'projectIntentUnavailable')}`,
        ...wrapConsoleText(`说明 · ${sanitizeDiagnosticText(projectIntentIssue.message)}`,
          Math.max(20, size.columns - 8)),
      ] : []),
      ...allTargets.flatMap(({ target, state }) => [
        ...wrapConsoleText(
          `${target.pluginId} · ${platformLabel(target.platform)} · ${scopeLabel(target.scope)}`,
          Math.max(20, size.columns - 8),
        ),
        ...(target.reasonCodes.length > 0
          ? target.reasonCodes.flatMap((code) => wrapConsoleText(
              `原因 · ${safeDiagnosticCode(code, 'projectTargetUnknown')}`,
              Math.max(20, size.columns - 8),
            ))
          : [state === 'actionable' ? '原因 · confirmedDifference'
              : state === 'blocked' ? '原因 · blocked' : '原因 · unconfirmed']),
      ]),
    ];
    const technicalPageRows = responsiveBudget(4, 8);
    const technicalOffset = Math.min(batchTargetOffset,
      Math.max(0, technicalLines.length - 1));
    const visibleTechnicalLines = technicalLines.slice(
      technicalOffset,
      technicalOffset + technicalPageRows,
    );
    referenceDetailPagination = showTechnical && technicalLines.length > 0
      ? { total: technicalLines.length, pageRows: technicalPageRows }
      : undefined;
    content = <Box flexDirection="column">
      <PinnedActionBar
        actions={pinnedActions.map((action, index) => ({
          id: action.actionId ?? `${action.label}:${index}`,
          label: action.label,
          disabled: Boolean(action.disabled),
        }))}
        active={focusZone === 'actions'}
        focus={pinnedActionFocus}
        visibleCount={policy.mode === 'compact' ? 2 : 3}
      />
      {projectIntentIssue || unconfirmed.length > 0 ? <StaticRow status="warning"
        title="? 未知状态不等于未安装；没有自动执行安装或恢复。" compact /> : null}
      {actionable.length > 0 && blocked.length + unconfirmed.length > 0
        ? <StaticRow status="info"
          title={`只同步明确项；保留 ${blocked.length} 个受阻位置和 ${unconfirmed.length} 个未确认位置。`}
          compact />
        : null}
      {showTechnical ? <TechnicalDetails title="项目状态安全详情" compact>
        {technicalOffset > 0
          ? <StaticRow title={`↑ 前面还有 ${technicalOffset} 行`} status="muted" compact /> : null}
        {visibleTechnicalLines.map((line, index) => <StaticRow
          key={`${technicalOffset + index}:${line}`} title={line} compact />)}
        {technicalOffset + visibleTechnicalLines.length < technicalLines.length
          ? <StaticRow title={`↓ 后面还有 ${technicalLines.length - technicalOffset - visibleTechnicalLines.length} 行`}
            status="muted" compact /> : null}
      </TechnicalDetails> : <ContentViewport>
        <SemanticRows actions={actions} focus={focusZone === 'content' ? focus : -1}
          kind="section" cards columns={size.columns - 2} compact={policy.mode === 'compact'}
          offset={viewport.offset} limit={viewport.limit} />
      </ContentViewport>}
    </Box>;
  } else if (route.name === 'pluginList') {
    const sourceId = route.sourceId ?? 'all';
    const items = props.controller.listPlugins({
      mode: route.mode,
      ...(sourceId !== 'all' ? { sourceId } : {}),
      ...(query ? { query } : {}),
      installFilter,
    });
    const filterCounts = Object.fromEntries(PLUGIN_FILTERS.map((filter) => [filter,
      props.controller.listPlugins({
        mode: route.mode,
        ...(sourceId !== 'all' ? { sourceId } : {}),
        ...(query ? { query } : {}),
        installFilter: filter,
      }).length,
    ])) as Record<PluginInstallFilter, number>;
    breadcrumb = '插件';
    title = '插件';
    description = '浏览、安装和管理所有插件。选择会跨来源、搜索和筛选保留。';
    context = `${items.length} 个插件`;
    help = focusZone === 'actions'
      ? '←→/↑↓ 操作 · Enter 执行 · Tab 插件列表 · Esc 返回'
      : '↑↓ 插件 · Enter 查看 · Tab 操作栏 · m 多选 · / 搜索 · f 状态 · Esc 返回';
    const sourceError = sourceId !== 'all'
      && props.controller.getSourceOverview(sourceId).health?.state === 'unavailable';
    actions = sourceError
      ? [{ label: '查看来源问题', description: '当前不能浏览这个来源', run: () => go({ name: 'issueDetail', issueId: `source:${sourceId}:unavailable` }) }]
      : [];
    choosePluginListFilter = (nextFilter) => {
      const selectedPluginId = pluginRows[focus]?.pluginId ?? pluginListFocusId.current;
      const nextItems = props.controller.listPlugins({
        mode: route.mode,
        ...(route.sourceId ? { sourceId: route.sourceId } : {}),
        ...(query ? { query } : {}),
        installFilter: nextFilter,
      });
      const nextRowIds = pluginListRowIds(route.mode, nextItems, query);
      const retained = selectedPluginId ? nextRowIds.indexOf(selectedPluginId) : -1;
      setInstallFilter(nextFilter);
      props.controller.updatePageContext({ installFilter: nextFilter });
      setFocus(retained >= 0 ? retained : 0);
      setScrollOffset(0);
    };
    togglePluginListFilter = () => {
      const nextFilter = PLUGIN_FILTERS[(PLUGIN_FILTERS.indexOf(installFilter) + 1)
        % PLUGIN_FILTERS.length]!;
      choosePluginListFilter?.(nextFilter);
    };
    choosePluginListSource = (next) => {
      const selectedPluginId = pluginRows[focus]?.pluginId;
      const nextItems = props.controller.listPlugins({
        mode: route.mode,
        ...(next !== 'all' ? { sourceId: next } : {}),
        ...(query ? { query } : {}),
        installFilter,
      });
      const nextSourceUnavailable = next !== 'all'
        && props.controller.getSourceOverview(next).health?.state === 'unavailable';
      const nextRowIds = pluginListRowIds(route.mode, nextItems, query, nextSourceUnavailable);
      const retained = selectedPluginId ? nextRowIds.indexOf(selectedPluginId) : -1;
      props.controller.replace(
        { name: 'pluginList', mode: route.mode, ...(next !== 'all' ? { sourceId: next } : {}) },
        { ...snapshot.router.current.context, query, installFilter, sourceTabId: next },
      );
      const retainedFocus = retained >= 0
        ? retained
        : nextItems[0] ? nextRowIds.indexOf(nextItems[0].pluginId) : 0;
      setFocus(retainedFocus);
      setScrollOffset(retainedFocus >= 4 ? retainedFocus - 3 : 0);
    };
    movePluginListSource = (direction) => {
      const tabs = ['all', ...props.controller.listSources().map((source) => source.id)];
      const index = tabs.indexOf(sourceId);
      choosePluginListSource?.(tabs[(index + direction + tabs.length) % tabs.length]!);
    };
    const listedPluginIds = new Set(items.map((item) => item.pluginId));
    const recommendedUpdateCandidates = props.controller.listPluginWriteTaskCandidates('update')
      .filter((candidate) => candidate.eligible && listedPluginIds.has(candidate.target.pluginId));
    const recommendedUpdatePluginIds = [...new Set(recommendedUpdateCandidates
      .map((candidate) => candidate.target.pluginId))];
    const projectRestoreCandidates = props.controller.listPluginWriteTaskCandidates('restore')
      .filter((candidate) => candidate.target.scope === 'project');
    const projectIntentRoots = props.controller.listCurrentProjectIntentRoots();
    const menuActions: ActionItem[] = [
      ...(recommendedUpdatePluginIds.length > 0 ? [{
        actionId: 'plugin-list-update',
        label: `更新 ${recommendedUpdatePluginIds.length} 个`,
        description: '使用已验证版本和现有安装位置，直接查看任务确认',
        status: 'warning' as const,
        run: () => openRecommendedUpdateTask(recommendedUpdatePluginIds),
      }] : []),
      ...(projectIntentRoots.length > 0 ? [{
        actionId: 'plugin-list-project',
        label: '项目清单',
        description: `${projectIntentRoots.length} 个已保存根插件；允许补齐当前项目缺少的安装`,
        status: 'info' as const,
        run: prepareCurrentProjectPlugins,
      }] : []),
      ...(projectRestoreCandidates.length > 0 ? [{
        actionId: 'plugin-list-repair-project',
        label: '修复项目',
        description: '严格按已确认的现有版本修复异常，不改变插件版本',
        status: 'warning' as const,
        run: () => openSelectedPluginTask('restore', [...new Set(projectRestoreCandidates
          .map((candidate) => candidate.target.pluginId))], 'project'),
      }] : []),
      {
        actionId: 'plugin-list-multi',
        label: query ? 'm 当前结果多选' : 'm 多选',
        description: '先选择插件，再选择安装、更新、恢复、卸载或维护任务',
        status: 'info' as const,
        run: () => openBatchSelection(),
      },
    ];
    const toolActions: ActionItem[] = [
      {
        actionId: 'plugin-list-filter',
        label: `筛选：${pluginFilterLabel(installFilter)}`,
        run: () => setPluginListChooser({
          kind: 'status',
          focus: Math.max(0, PLUGIN_FILTERS.indexOf(installFilter)),
        }),
      },
      { actionId: 'plugin-list-search', label: '/ 搜索', run: () => setSearchFocus(true) },
      {
        actionId: 'plugin-list-source',
        label: `来源：${sourceId === 'all' ? '全部' : sourceId}`,
        run: () => setPluginListChooser({
          kind: 'source',
          focus: Math.max(0, ['all', ...props.controller.listSources().map((source) => source.id)]
            .indexOf(sourceId)),
        }),
      },
    ];
    const pluginRowsById = new Map<string, PluginListRowViewModel>([
      ...items.map((item): [string, PluginListRowViewModel] => [item.pluginId, {
      pluginId: item.pluginId,
      name: item.displayName,
      sourceLabel: item.sourceLabel,
      description: item.configOnly
        ? '来源当前没有这个插件；可以查看已保存设置或定点重置设置层。'
        : item.description,
      ...(item.primaryAttention ? { attention: item.primaryAttention.message } : {}),
      placementSummary: '',
      tags: pluginPlatformBadges(item),
      statusLabel: statusText(item),
      status: pluginRowStatus(item),
      }]),
    ]);
    pluginRows = pluginListRowIds(route.mode, items, query, sourceError)
      .flatMap((rowId) => pluginRowsById.get(rowId) ?? []);
    if (pluginRows[focus]) pluginListFocusId.current = pluginRows[focus].pluginId;
    if (installFilter === 'updateAvailable'
      && items.length === 0 && !sourceError) {
      title = '没有可更新插件';
      description = '当前筛选范围内没有经过版本证据确认的更新。';
      actions = [{
        label: '查看全部我的插件',
        description: '按 f 返回完整列表',
        run: () => {
          setInstallFilter('all');
          props.controller.updatePageContext({ installFilter: 'all' });
        },
      }];
    } else if (query && items.length === 0 && !sourceError) {
      title = '搜索没有匹配插件';
      description = `“${query}”在当前来源和状态筛选中没有匹配项。`;
      actions = [{
        label: '清除搜索',
        description: '保留当前来源和状态筛选',
        run: () => {
          setQuery('');
          props.controller.updatePageContext({ query: '' });
        },
      }];
    } else if (sourceId !== 'all' && items.length === 0 && !sourceError) {
      title = route.mode === 'installed' ? '当前来源没有已添加插件' : '当前来源没有可显示插件';
      description = `来源 ${sourceId} 在当前状态筛选中没有匹配插件。`;
      actions = [{
        label: '查看全部来源',
        description: '保留当前状态筛选',
        run: () => {
          props.controller.replace({ name: 'pluginList', mode: route.mode });
          props.controller.updatePageContext({ sourceTabId: 'all' });
          setFocus(0);
          setScrollOffset(0);
        },
      }];
    } else if (items.length === 0 && !sourceError) {
      actions = [{
        label: installFilter !== 'all' ? '查看全部插件' : '没有可显示插件',
        description: installFilter !== 'all'
          ? '当前状态筛选没有匹配插件'
          : '当前所有来源都没有可浏览的插件',
        ...(installFilter !== 'all' ? { run: () => {
          setInstallFilter('all');
          props.controller.updatePageContext({ installFilter: 'all' });
        } } : { disabled: '没有可打开的插件' }),
      }];
    }
    pinnedActions = dedupeActions([
      ...(sourceError ? actions : []),
      ...(pluginRows.length > 0 ? menuActions : actions),
      ...toolActions,
    ]);
    const pluginListStaticRows = 4;
    const viewport = pluginRows.length === 0
      ? actionViewport(actions, policy.mode === 'compact', focus, scrollOffset, pageActionBudget(pluginListStaticRows))
      : rowViewport({
          rowHeights: pluginRows.map((row) => row.attention ? 6 : 5),
          focus,
          requestedOffset: scrollOffset,
          rowBudget: pageActionBudget(pluginListStaticRows),
        });
    if (viewport.hiddenBefore > 0 || viewport.hiddenAfter > 0) {
      context = `${items.length} 个插件 · ${viewport.position}/${viewport.total}`;
    }
    content = (
      <Box flexDirection="column">
        <PinnedActionBar
          actions={pinnedActions.map((action, index) => ({
            id: action.actionId ?? `${action.label}:${index}`,
            label: action.label,
            disabled: Boolean(action.disabled),
          }))}
          active={!pluginListChooser && focusZone === 'actions'}
          focus={pinnedActionFocus}
          visibleCount={policy.mode === 'compact' ? 2 : 3}
        />
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
        <Text wrap="truncate-end" color={tuiTheme.colors.muted}>状态  <Text color={tuiTheme.colors.accent}>[{pluginFilterLabel(installFilter)} {filterCounts[installFilter]}]</Text>  全部 {filterCounts.all} · 已装 {filterCounts.installed} · 未装 {filterCounts.uninstalled} · 更新 {filterCounts.updateAvailable} · 处理 {filterCounts.attention}  f 切换</Text>
        {sourceError
          ? <Callout status="error" title={`${sourceId} 暂时无法提供插件`} description="当前不能浏览这个来源。" />
          : route.mode === 'installed' && items.length === 0 && !query && sourceId === 'all'
            ? installFilter === 'updateAvailable'
              ? <Callout title="没有可更新插件" description="当前筛选范围内没有经过版本证据确认的更新。" />
              : <Callout title="开始添加第一个插件" description="插件可以安装到 Codex、Claude Code 或两者。" />
            : null}
        <ContentViewport>
          {pluginRows.length > 0
            ? <PluginRows rows={pluginRows} focus={focus} viewport={viewport}
                active={!pluginListChooser && focusZone === 'content'} />
            : <SemanticRows actions={actions}
                focus={!pluginListChooser && focusZone === 'content' ? focus : -1}
                kind="action" compact={policy.mode === 'compact'} offset={viewport.offset} limit={viewport.limit} />}
        </ContentViewport>
      </Box>
    );
  } else if (route.name === 'batchSelection') {
    breadcrumb = '插件 / 选择多个';
    title = batchDraft?.stage === 'task' ? `为 ${batchDraft.selectedPluginIds.length} 个插件选择任务`
      : batchDraft?.stage === 'maintenance' ? '其他维护方式'
        : '选择插件';
    description = batchDraft?.stage === 'select'
      ? 'Space 切换选择，Enter 查看插件。选择会跨来源、搜索和筛选保留。'
      : batchDraft?.stage === 'task'
        ? '更新和恢复沿用已经添加的位置；移除会逐项显示已有位置。'
        : '同步、重新安装和普通清理使用所选插件的已有位置。';
    if (!batchDraft) {
      actions = [{ label: '返回插件列表', run: back }];
      content = <SemanticRows actions={actions} focus={focus} kind="action" compact />;
    } else if (batchDraft.stage === 'select') {
      const candidates = batchCandidates(batchDraft);
      const selected = new Set(batchDraft.selectedPluginIds);
      const currentIds = new Set(candidates.map((candidate) => candidate.pluginId));
      const hiddenSelected = batchDraft.selectedPluginIds.filter((pluginId) => !currentIds.has(pluginId)).length;
      const candidateActions: ActionItem[] = candidates.map((candidate) => {
        const blockReason = batchCandidateBlockReason(batchDraft, candidate);
        const isSelected = selected.has(candidate.pluginId);
        const plugin = candidate.plugin;
        return {
          label: plugin
            ? `${plugin.displayName} · ${plugin.sourceLabel}`
            : `${candidate.pluginId}（已不可用，可取消选择）`,
          description: plugin
            ? `${plugin.description} · ${blockReason
                ? `${isSelected ? '可取消选择' : '不可选择'}：${blockReason}`
                : statusText(plugin)}`
            : `${isSelected ? '可取消选择' : '不可选择'}：${blockReason}`,
          meta: plugin ? batchPluginVersionSummary(plugin) : '版本待确认',
          tags: plugin ? pluginPlatformBadges(plugin) : undefined,
          selected: isSelected,
          pluginId: candidate.pluginId,
          canSelectNew: blockReason === undefined,
          status: blockReason ? 'muted' : undefined,
          run: candidate.plugin
            ? () => go({ name: 'pluginDetail', pluginId: candidate.pluginId })
            : undefined,
        };
      });
      const selectableIds = candidates
        .filter((candidate) => batchCandidateBlockReason(batchDraft, candidate) === undefined)
        .map((candidate) => candidate.pluginId);
      const continueSelection = (): void => {
        if (batchDraft.selectedPluginIds.length === 0) {
          setActionError('请至少选择一个插件。');
          return;
        }
        const invalid = invalidBatchSelection(batchDraft);
        if (invalid.length > 0) {
          setActionError(`${invalid.length} 个已选插件已不可用。请先在“查看全部已选”中取消选择。`);
          return;
        }
        if (batchDraft.recommendedGoal) {
          openSelectedPluginTask(batchDraft.recommendedGoal, batchDraft.selectedPluginIds);
          return;
        }
        moveBatchStage('task');
      };
      const continueAction: ActionItem = {
        actionId: 'batch-selection-continue',
        label: `查看确认（${batchDraft.selectedPluginIds.length}）`,
        description: batchDraft.selectedPluginIds.length > 0
          ? batchDraft.recommendedGoal ? '重新读取更新信息并显示操作汇总' : '继续选择任务和确认范围'
          : '先选择至少一个插件',
        disabled: batchDraft.selectedPluginIds.length === 0 ? '先选择至少一个插件' : undefined,
        run: continueSelection,
      };
      const selectedSetAction: ActionItem = {
        label: batchDraft.showSelected ? '返回当前结果' : `查看全部已选（${batchDraft.selectedPluginIds.length}）`,
        description: hiddenSelected > 0 ? `${hiddenSelected} 个选择在其他筛选中` : '包括其他筛选中的选择',
        run: () => {
          setBatchDraft((current) => current ? {
            ...current,
            showSelected: !current.showSelected,
            showSelectionTools: false,
          } : current);
          setFocus(0);
          setScrollOffset(0);
          setFocusZone('content');
        },
      };
      const selectionToolActions: ActionItem[] = [
        {
          label: '返回插件选择',
          description: '保留当前已选插件',
          run: () => {
            setBatchDraft((current) => current ? { ...current, showSelectionTools: false } : current);
            setFocus(0);
            setScrollOffset(0);
            setFocusZone('content');
          },
        },
        {
          label: '全选当前结果',
          description: `${selectableIds.length} 个当前筛选下可选结果，包括滚动范围外`,
          run: () => setBatchDraft((current) => current ? {
            ...current,
            selectedPluginIds: [...new Set([...current.selectedPluginIds, ...selectableIds])],
          } : current),
        },
        {
          label: '取消当前结果',
          description: '保留其他来源或搜索中的选择',
          run: () => setBatchDraft((current) => current ? {
            ...current,
            selectedPluginIds: current.selectedPluginIds.filter((pluginId) => !currentIds.has(pluginId)),
          } : current),
        },
        {
          label: '清空全部已选',
          run: () => setBatchDraft((current) => current ? { ...current, selectedPluginIds: [] } : current),
        },
      ];
      const selectionToolsAction: ActionItem = {
        actionId: 'batch-selection-tools',
        label: batchDraft.showSelectionTools ? '返回插件选择' : '选择工具',
        description: '全选、取消当前结果或清空全部选择',
        run: () => {
          setBatchDraft((current) => current ? {
            ...current,
            showSelectionTools: !current.showSelectionTools,
          } : current);
          setFocus(0);
          setScrollOffset(0);
          setFocusZone('content');
        },
      };
      actions = batchDraft.showSelectionTools ? selectionToolActions : candidateActions;
      pinnedActions = [continueAction, selectedSetAction, selectionToolsAction];
      const batchFocus = Math.min(focus, Math.max(0, actions.length - 1));
      context = `已选 ${batchDraft.selectedPluginIds.length} 个 · 显示 ${candidates.length} 个${hiddenSelected > 0 ? ` · 隐藏 ${hiddenSelected} 个` : ''}`;
      help = batchDraft.showSelectionTools
        ? '↑↓ 移动 · Enter 执行 · Tab 操作栏 · Esc 返回选择'
        : '↑↓ 移动 · Space 选择 · Enter 查看 · Tab 操作栏 · c 查看确认 · ←→ 来源 · / 搜索 · f 状态 · Esc 返回';
      const cardWidth = Math.max(20, size.columns - 2);
      const viewport = batchDraft.showSelectionTools
        ? actionViewport(actions, policy.mode === 'compact', batchFocus, scrollOffset,
            Math.max(1, pageActionBudget(4)))
        : objectCardActionViewport(actions, cardWidth, policy.mode === 'compact', batchFocus,
            scrollOffset, Math.max(1, pageActionBudget(4)));
      content = <Box flexDirection="column">
        <PinnedActionBar
          actions={pinnedActions.map((action) => ({
            id: action.actionId ?? action.label,
            label: action.label,
            disabled: Boolean(action.disabled),
          }))}
          active={focusZone === 'actions'}
          focus={pinnedActionFocus}
          visibleCount={policy.mode === 'compact' ? 2 : 3}
        />
        <SourceTabs
          controller={props.controller}
          current={batchDraft.showSelected ? 'all' : batchDraft.sourceId ?? 'all'}
          compact={policy.mode === 'compact'}
          columns={size.columns - 2}
          mode={batchDraft.mode}
          query={batchDraft.showSelected ? undefined : batchDraft.query || undefined}
          installFilter={batchDraft.showSelected ? 'all' : batchDraft.installFilter}
        />
        <Text color={searchFocus ? tuiTheme.colors.accent : tuiTheme.colors.muted}>搜索  / {searchFocus
          ? <InputDisplay value={batchDraft.query} placeholder="输入搜索内容" columns={Math.max(8, size.columns - 14)} />
          : <>{batchDraft.query || '搜索名称、用途或来源…'}{batchDraft.query ? '    / 编辑' : ''}</>}</Text>
        <Text color={tuiTheme.colors.muted}>状态  <Text color={tuiTheme.colors.accent}>[{pluginFilterLabel(batchDraft.installFilter)}]</Text>  f 切换</Text>
        <ContentViewport>
          {batchDraft.showSelectionTools
            ? <SemanticRows actions={actions} focus={focusZone === 'content' ? batchFocus : -1}
                kind="action" compact={policy.mode === 'compact'} offset={viewport.offset} limit={viewport.limit} />
            : <Box flexDirection="column">
                {actions.slice(viewport.offset, viewport.offset + viewport.limit).map((action, visibleIndex) => (
                  <ObjectCardRow
                    key={action.pluginId ?? action.label}
                    width={cardWidth}
                    title={`${action.selected ? '[x]' : '[ ]'} ${action.label}`}
                    description={action.disabled ?? action.description ?? ''}
                    meta={action.meta}
                    tags={action.tags}
                    focused={focusZone === 'content' && viewport.offset + visibleIndex === batchFocus}
                    anchored={focusZone !== 'content' && viewport.offset + visibleIndex === batchFocus}
                    compact={policy.mode === 'compact'}
                  />
                ))}
              </Box>}
        </ContentViewport>
      </Box>;
    } else {
      const selectedIds = batchDraft.selectedPluginIds;
      const taskCandidates = (goal: PluginWriteTaskGoal): PluginWriteTaskCandidate[] => {
        const selected = new Set(selectedIds);
        return props.controller.listPluginWriteTaskCandidates(goal)
          .filter((candidate) => selected.has(candidate.target.pluginId));
      };
      const startExistingBatch = (action: 'sync' | 'reinstall' | 'uninstall' | 'cleanup'): void => {
        if (invalidBatchSelection(batchDraft).length > 0) {
          setActionError('已选插件状态已变化。请返回选择页检查并取消失效项。');
          return;
        }
        const exactTargets = props.controller.listPluginWriteBatchTargets(action, selectedIds);
        if (exactTargets.length === 0) {
          setActionError('所选插件没有可用的已有安装位置。');
          return;
        }
        setBatchDraft((current) => current ? {
          ...current,
          action,
          maintenanceTargets: exactTargets,
          selectedMaintenanceTargetKeys: exactTargets.map(batchTargetKey),
          showPlacementTargets: false,
        } : current);
        beginReview({
          kind: 'pluginWriteBatch', action,
          selection: { kind: 'targets', targets: exactTargets },
          platform: exactTargets[0]!.platform,
          scope: exactTargets[0]!.scope,
        });
      };
      const syncTargets = props.controller.listPluginWriteBatchTargets('sync', selectedIds);
      const uninstallTargets = props.controller.listPluginWriteBatchTargets('uninstall', selectedIds);
      if (batchDraft.stage === 'maintenance') {
        actions = [
          { label: '同步已保存使用设置', description: `重新应用 ${syncTargets.length} 个已保存或现场目标`, run: () => startExistingBatch('sync') },
          { label: '重新安装', description: `重新生成 ${props.controller.listPluginWriteBatchTargets('reinstall', selectedIds).length} 个已保存或现场目标`, run: () => startExistingBatch('reinstall') },
          { label: '清理遗留内容', description: `${props.controller.listPluginWriteBatchTargets('cleanup', selectedIds).length} 个已核验位置；保留不属于插件或被共用的内容`, run: () => startExistingBatch('cleanup') },
          {
            label: '返回任务选择',
            run: () => moveBatchStage('task'),
          },
        ];
      } else {
        const updates = taskCandidates('update');
        const restores = taskCandidates('restore');
        const updateRoots = new Set(updates.map((candidate) => candidate.target.pluginId)).size;
        const restoreRoots = new Set(restores.map((candidate) => candidate.target.pluginId)).size;
        const addTargetCount = (['project', 'user'] as const).flatMap((scope) =>
          props.controller.listPluginInstallBatchTargets(selectedIds, 'both', scope))
          .filter((target) => target.state === 'add').length;
        actions = [
          ...(updates.length > 0 ? [{
            label: `更新所选中的 ${updateRoots} 个可更新插件`,
            description: '使用已验证版本和已经添加的位置',
            status: 'warning' as const,
            run: () => openSelectedPluginTask('update', selectedIds),
          }] : []),
          ...(restores.length > 0 ? [{
            label: `恢复所选中的 ${restoreRoots} 个插件`,
            description: '按当前问题检查已经添加的位置',
            status: 'warning' as const,
            run: () => openSelectedPluginTask('restore', selectedIds),
          }] : []),
          {
            label: '安装到缺失位置',
            description: `${addTargetCount} 个当前工具和范围内的可安装位置`,
            disabled: addTargetCount === 0 ? '当前选择没有可安装位置' : undefined,
            run: () => {
              setBatchDraft((current) => current ? { ...current, action: 'install' } : current);
              props.controller.push({ name: 'batchInstallPlatforms' });
              setFocus(0);
              setScrollOffset(0);
            },
          },
          { label: '卸载所选插件', description: `${uninstallTargets.length} 个现有位置；可在下一页删减范围；保留设置`, status: 'error', run: () => startExistingBatch('uninstall') },
          {
            label: '其他维护方式',
            description: '同步、重新安装和普通清理',
            run: () => moveBatchStage('maintenance'),
          },
          { label: '返回调整选择', run: () => moveBatchStage('select') },
        ];
      }
      context = `${selectedIds.length} 个插件 · ${syncTargets.length} 个已保存或现场目标`;
      help = '↑↓ 移动 · Enter 选择 · Esc 返回修改';
      const viewport = actionViewport(actions, policy.mode === 'compact', focus, scrollOffset, pageActionBudget(1));
      content = <SemanticRows actions={actions} focus={focus} kind="task" compact={policy.mode === 'compact'} offset={viewport.offset} limit={viewport.limit} />;
    }
  } else if (route.name === 'batchInstallPlatforms' && batchDraft?.action === 'install') {
    breadcrumb = '插件 / 批量安装 / 平台';
    context = `第 1 步，共 3 步 · ${batchDraft.selectedPluginIds.length} 个插件`;
    title = '选择安装平台';
    description = '先选择原生平台。下一步再选择使用范围和检查精确目标。';
    const selectedPlatforms = batchDraft.platform === 'both'
      ? new Set<PlatformName>(['codex', 'claude'])
      : new Set<PlatformName>([batchDraft.platform]);
    const togglePlatform = (platform: PlatformName): void => {
      setBatchDraft((current) => {
        if (!current) return current;
        const next = current.platform === 'both'
          ? new Set<PlatformName>(['codex', 'claude'])
          : new Set<PlatformName>([current.platform]);
        if (next.has(platform)) {
          if (next.size === 1) {
            setActionError('至少选择一个目标平台。');
            return current;
          }
          next.delete(platform);
        } else next.add(platform);
        setActionError(undefined);
        return { ...current, platform: next.size === 2 ? 'both' : [...next][0]! };
      });
    };
    const confirmPlatforms: ActionItem = {
      actionId: 'batch-install-platforms-confirm',
      label: '确定所选平台',
      description: `${[...selectedPlatforms].map(platformLabel).join('、')} · 继续选择目标`,
      run: () => {
        props.controller.push({ name: 'batchInstallScope' });
        setFocus(0);
        setScrollOffset(0);
      },
    };
    actions = [
      {
        actionId: 'batch-install-platform-codex',
        label: 'Codex',
        description: '添加到 Codex 的合法缺失位置',
        selected: selectedPlatforms.has('codex'),
        run: () => togglePlatform('codex'),
      },
      {
        actionId: 'batch-install-platform-claude',
        label: 'Claude Code',
        description: '添加到 Claude Code 的合法缺失位置',
        selected: selectedPlatforms.has('claude'),
        run: () => togglePlatform('claude'),
      },
      confirmPlatforms,
    ];
    pinnedActions = [confirmPlatforms];
    help = '↑↓ 移动 · Enter 选择/确定 · c 确定所选平台 · Esc 返回任务选择';
    content = <Box flexDirection="column">
      <PinnedActionBar actions={[{ id: confirmPlatforms.actionId!, label: confirmPlatforms.label }]}
        active={focusZone === 'actions'} focus={pinnedActionFocus} />
      <ContentViewport>
        <SemanticRows actions={actions.slice(0, 2)} focus={focusZone === 'content' ? focus : -1}
          kind="choice" compact={policy.mode === 'compact'} />
        <SemanticRows actions={actions} focus={focusZone === 'content' ? focus : -1}
          kind="action" compact offset={2} />
      </ContentViewport>
    </Box>;
  } else if (route.name === 'batchInstallScope' || route.name === 'batchPlacement') {
    breadcrumb = route.name === 'batchInstallScope'
      ? '插件 / 批量安装 / 目标' : '插件 / 批量操作 / 位置';
    const maintenanceTargets = batchDraft?.maintenanceTargets ?? [];
    const maintenanceSelection = new Set(batchDraft?.selectedMaintenanceTargetKeys ?? []);
    const maintenanceMode = (batchDraft?.maintenanceGoal !== undefined
      || batchDraft?.action !== undefined && batchDraft.action !== 'install')
      && maintenanceTargets.length > 0;
    const maintenanceLabel = batchDraft?.maintenanceGoal === 'update' ? '更新'
      : batchDraft?.maintenanceGoal === 'restore' ? '恢复'
        : batchDraft?.action ? batchActionLabel(batchDraft.action) : '处理';
    title = route.name === 'batchInstallScope' ? '选择安装目标'
      : maintenanceMode ? `确认批量${maintenanceLabel}范围`
      : batchDraft?.selection === 'currentProjectIntentRoots'
      ? '同步当前项目全部保存目标'
      : `设置批量${batchDraft?.action ? batchActionLabel(batchDraft.action) : ''}位置`;
    description = route.name === 'batchInstallScope'
      ? '选择范围后检查可添加、已有和受阻的精确位置。操作汇总之后才执行。'
      : maintenanceMode
      ? '默认沿用进入此页时的现有位置。可以取消位置，也可以恢复本次集合中的位置。'
      : '分别选择使用范围和工具。操作汇总会重新读取状态；本次安装位置变化时需要重新确认。';
    let installPlacementTargets: ReturnType<TuiController['listPluginInstallBatchTargets']> = [];
    let installPlacementGroups: Array<{
      title?: string;
      kind: SemanticRowKind;
      actions: ActionItem[];
    }> = [];
    let installPlacementActions: ActionItem[] = [];
    let maintenanceTargetCount = 0;
    if (!batchDraft?.action && !batchDraft?.maintenanceGoal) {
      actions = [{ label: '返回批量选择', run: back }];
    } else if (maintenanceMode) {
      const currentTargets = batchDraft.maintenanceGoal
        ? props.controller.listPluginWriteTaskCandidates(batchDraft.maintenanceGoal)
          .filter((candidate) => batchDraft.selectedPluginIds.includes(candidate.target.pluginId))
          .map((candidate) => candidate.target)
        : props.controller.listPluginWriteBatchTargets(
            batchDraft.action as Exclude<BatchPluginWriteAction, 'install'>,
            batchDraft.selectedPluginIds,
          );
      const frozenKeys = maintenanceTargets.map(batchTargetKey);
      const currentKeys = currentTargets.map(batchTargetKey);
      const targetEvidenceChanged = frozenKeys.length !== currentKeys.length
        || frozenKeys.some((key, index) => key !== currentKeys[index]);
      const selectedTargets = maintenanceTargets.filter((target) =>
        maintenanceSelection.has(batchTargetKey(target)));
      const targetActions: ActionItem[] = maintenanceTargets.map((target) => ({
        label: `${props.controller.getPluginOverview(target.pluginId)?.displayName ?? target.pluginId} · ${platformLabel(target.platform)} · ${scopeLabel(target.scope)}`,
        description: '本次处理这个现有位置',
        selected: maintenanceSelection.has(batchTargetKey(target)),
        run: () => setBatchDraft((current) => {
          if (!current) return current;
          const selectedKeys = new Set(current.selectedMaintenanceTargetKeys ?? []);
          const key = batchTargetKey(target);
          if (selectedKeys.has(key)) selectedKeys.delete(key);
          else selectedKeys.add(key);
          return { ...current, selectedMaintenanceTargetKeys: [...selectedKeys] };
        }),
      }));
      maintenanceTargetCount = targetActions.length;
      const confirmMaintenance: ActionItem = {
        actionId: 'batch-placement-confirm',
        label: `查看批量${maintenanceLabel}确认`,
        description: targetEvidenceChanged
          ? '安装位置已变化，请返回任务页重新选择'
          : `${selectedTargets.length} 个现有位置将处理`,
        disabled: targetEvidenceChanged ? '安装位置已变化，请重新确认本次范围'
          : selectedTargets.length === 0 ? '请至少保留一个处理位置' : undefined,
        run: () => beginReview(batchDraft.maintenanceGoal ? {
          kind: 'pluginWriteTask',
          goal: batchDraft.maintenanceGoal,
          targets: selectedTargets,
          executionPolicy: 'all',
        } : {
          kind: 'pluginWriteBatch',
          action: batchDraft.action as Exclude<BatchPluginWriteAction, 'install'>,
          selection: { kind: 'targets', targets: selectedTargets },
          platform: selectedTargets[0]!.platform,
          scope: selectedTargets[0]!.scope,
        }),
      };
      actions = [
        ...targetActions,
        confirmMaintenance,
        { label: '返回任务选择', run: back },
      ];
      pinnedActions = [confirmMaintenance];
    } else {
      const projectIntent = batchDraft.selection === 'currentProjectIntentRoots';
      installPlacementTargets = batchDraft.action === 'install'
        && batchDraft.selection === 'selected'
        ? props.controller.listPluginInstallBatchTargets(
            batchDraft.selectedPluginIds,
            batchDraft.platform,
            batchDraft.scope,
          )
        : [];
      const addTargets = installPlacementTargets.filter((target) => target.state === 'add');
      const blockedTargets = installPlacementTargets.filter((target) => target.state === 'blocked');
      const existingTargets = installPlacementTargets.filter((target) => target.state === 'existing');
      installPlacementGroups = [
        {
          title: '在哪里使用',
          kind: 'choice',
          actions: [
            {
              actionId: 'batch-placement-scope-project',
              label: '当前项目', selected: batchDraft.scope === 'project',
              run: () => setBatchDraft((current) => current ? { ...current, scope: 'project' } : current),
            },
            {
              actionId: 'batch-placement-scope-user',
              label: '所有项目', selected: batchDraft.scope === 'user',
              disabled: projectIntent ? '项目全部同步固定使用当前项目' : undefined,
              run: () => setBatchDraft((current) => current ? { ...current, scope: 'user' } : current),
            },
          ],
        },
        {
          kind: 'action',
          actions: [
            ...(installPlacementTargets.length > 0 ? [{
              actionId: 'batch-placement-details',
              label: '查看全部位置和受阻原因',
              description: `${addTargets.length} 个可添加 · ${existingTargets.length} 个已有 · ${blockedTargets.length} 个受阻`,
              run: () => {
                setBatchDraft((current) => current ? { ...current, showPlacementTargets: true } : current);
                setFocus(0);
                setScrollOffset(0);
              },
            }] : []),
            {
              actionId: 'batch-placement-confirm',
              label: batchDraft.action === 'install' && blockedTargets.length > 0
                ? `仅添加可执行的 ${addTargets.length} 个位置`
                : `查看批量${batchActionLabel(batchDraft.action!)}确认`,
              description: batchDraft.action === 'install'
                ? `${addTargets.length} 个可添加 · ${existingTargets.length} 个已有 · ${blockedTargets.length} 个受阻`
                : `${batchDraft.selection === 'selected' ? `${batchDraft.selectedPluginIds.length} 个所选插件` : '当前项目全部保存目标'} · ${scopeLabel(batchDraft.scope)}`,
              disabled: batchDraft.selection === 'selected' && batchDraft.selectedPluginIds.length === 0
                ? '请至少选择一个插件'
                : batchDraft.action === 'install' && addTargets.length === 0
                  ? '所选工具和位置没有可添加目标'
                  : undefined,
              run: () => {
                if (invalidBatchSelection(batchDraft).length > 0) {
                  setActionError('已选插件状态已变化。请返回选择页检查并取消失效项。');
                  return;
                }
                const intent: OperationIntent = {
                  kind: 'pluginWriteBatch',
                  action: batchDraft.action!,
                  selection: batchDraft.action === 'install'
                    ? { kind: 'targets', targets: addTargets.map(({ pluginId, platform, scope }) => ({
                        pluginId, platform, scope,
                      })) }
                    : batchDraft.selection === 'selected'
                    ? {
                        kind: 'selected',
                        pluginIds: [...new Set(batchDraft.selectedPluginIds)]
                          .sort((left, right) => left.localeCompare(right, 'en')),
                      }
                    : { kind: 'currentProjectIntentRoots' },
                  platform: addTargets[0]?.platform ?? batchDraft.platform,
                  scope: addTargets[0]?.scope ?? batchDraft.scope,
                };
                beginReview(intent);
                setDirty(false);
                setFocus(0);
                setScrollOffset(0);
              },
            },
          ],
        },
      ];
      installPlacementActions = installPlacementGroups.flatMap((group) => group.actions);
      if (route.name === 'batchInstallScope') {
        const confirmPlacement = installPlacementActions.find((action) =>
          action.actionId === 'batch-placement-confirm');
        if (confirmPlacement) pinnedActions = [confirmPlacement];
      }
      if (batchDraft.showPlacementTargets) {
        actions = [
          ...installPlacementTargets.map((target) => ({
            label: `${target.pluginId} · ${platformLabel(target.platform)} · ${scopeLabel(target.scope)}`,
            description: target.state === 'add' ? '可添加'
              : target.state === 'existing' ? '已有，不重复添加' : `受阻：${target.reason}`,
            status: target.state === 'add' ? 'success' as const
              : target.state === 'blocked' ? 'warning' as const : 'muted' as const,
          })),
          {
            label: '返回位置选择',
            run: () => {
              setBatchDraft((current) => current ? { ...current, showPlacementTargets: false } : current);
              restoreActionFocus('batch-placement-details');
            },
          },
        ];
      } else actions = installPlacementActions;
    }
    context = batchDraft?.selection === 'selected'
      ? maintenanceMode
        ? `${maintenanceSelection.size}/${maintenanceTargets.length} 个位置`
        : `${batchDraft.selectedPluginIds.length} 个插件`
      : '保存的项目目标';
    help = batchDraft?.showPlacementTargets
      ? '↑↓ 查看全部位置 · Esc 返回位置选择'
      : maintenanceMode
        ? '↑↓ 移动 · Enter 选择 · Tab 固定操作 · c 查看确认 · Esc 返回修改'
        : '↑↓ 移动 · Enter 选择 · Esc 返回修改';
    const placementDetail = Boolean(batchDraft?.showPlacementTargets);
    const viewport = actionViewport(
      actions,
      placementDetail ? false : policy.mode === 'compact',
      focus,
      scrollOffset,
      pageActionBudget(maintenanceMode ? 2 : 1),
    );
    if (maintenanceMode) {
      const targetOffset = Math.min(viewport.offset, maintenanceTargetCount);
      const targetLimit = Math.max(0,
        Math.min(maintenanceTargetCount, viewport.offset + viewport.limit) - targetOffset);
      const actionOffset = Math.max(0, viewport.offset - maintenanceTargetCount);
      const actionLimit = Math.max(0,
        Math.min(actions.length - maintenanceTargetCount,
          viewport.offset + viewport.limit - maintenanceTargetCount) - actionOffset);
      content = <Box flexDirection="column">
        <PinnedActionBar actions={[{
          id: pinnedActions[0]!.actionId!,
          label: pinnedActions[0]!.label,
          disabled: Boolean(pinnedActions[0]!.disabled),
        }]} active={focusZone === 'actions'} focus={pinnedActionFocus} />
        <SectionCard title="处理范围" meta={`${maintenanceSelection.size} 个位置`} compact>
          {targetLimit > 0 ? <SemanticRows
            actions={actions.slice(0, maintenanceTargetCount)}
            focus={focus}
            kind="toggle"
            compact
            offset={targetOffset}
            limit={targetLimit}
          /> : null}
        </SectionCard>
        {actionLimit > 0 ? <SemanticRows
          actions={actions.slice(maintenanceTargetCount)}
          focus={focus - maintenanceTargetCount}
          kind="action"
          compact={policy.mode === 'compact'}
          offset={actionOffset}
          limit={actionLimit}
        /> : null}
      </Box>;
    } else if (!placementDetail && batchDraft?.action === 'install') {
      content = <Box flexDirection="column">
        {route.name === 'batchInstallScope' && pinnedActions[0]
          ? <PinnedActionBar actions={[{
              id: pinnedActions[0].actionId!, label: pinnedActions[0].label,
              disabled: Boolean(pinnedActions[0].disabled),
            }]} active={focusZone === 'actions'} focus={pinnedActionFocus} />
          : null}
        <ContentViewport>
        {installPlacementGroups.map((group) => {
          const groupOffset = installPlacementActions.findIndex((action) =>
            action.actionId === group.actions[0]?.actionId);
          const localOffset = Math.max(0, viewport.offset - groupOffset);
          const localLimit = Math.max(0, Math.min(
            group.actions.length - localOffset,
            viewport.offset + viewport.limit - groupOffset - localOffset,
          ));
          if (localLimit === 0) return null;
          return <Box key={group.title ?? 'actions'} flexDirection="column">
            {group.title ? <Text color={tuiTheme.colors.muted}>{group.title}</Text> : null}
            <SemanticRows actions={group.actions}
              focus={focusZone === 'content' ? focus - groupOffset : -1} kind={group.kind}
              compact={group.kind === 'choice' || policy.mode === 'compact'}
              offset={localOffset} limit={localLimit} />
          </Box>;
        })}
        </ContentViewport>
      </Box>;
    } else content = <SemanticRows
        actions={actions}
        focus={focus}
        kind={placementDetail ? 'action' : 'choice'}
        compact={placementDetail ? false : policy.mode === 'compact'}
        offset={viewport.offset}
        limit={viewport.limit}
      />;
  } else if (route.name === 'portableSkillSelect' && plugin && snapshot.portableDraft) {
    const draft = snapshot.portableDraft;
    breadcrumb = `${plugin.displayName} / 通用 Skills`;
    context = `${draft.selectedCount} / ${draft.totalCount} 已选择`;
    title = '选择要安装的 Skills';
    description = '已根据插件依赖和当前设置准备候选；默认全部选择。';
    const visibleCandidates = portableSelectionView === 'selected'
      ? draft.candidates.filter((candidate) => candidate.selected)
      : draft.candidates;
    const continuePortableSelection = (): void => {
      if (!draft.canContinue) {
        setPortableEmptySelectionOpen(true);
        return;
      }
      go({ name: 'portableAgentMode', pluginId: plugin.pluginId });
    };
    const candidateActions: ActionItem[] = visibleCandidates.map((candidate) => ({
      label: candidate.name,
      selected: candidate.selected,
      description: `${candidate.description}${candidate.dynamic ? ' · 按设置生成' : ''}`,
      meta: `${candidate.providerDisplayName} · ${candidate.relation === 'requested' ? '当前插件'
        : candidate.relation === 'direct' ? '直接依赖插件' : '间接依赖插件'}`,
      tags: <Text color={tuiTheme.colors.muted}>[
        {candidate.availableScopes.map(scopeLabel).join('、') || '范围待确认'}
      ]{candidate.dynamic ? ' [按设置生成]' : ''}</Text>,
      run: () => go({
        name: 'portableSkillSummary',
        pluginId: plugin.pluginId,
        skillName: candidate.name,
      }),
    }));
    selectAllPortableCandidates = { actionId: 'portable-selection-select-all', label: '全选当前结果', run: () => {
        for (const candidate of visibleCandidates) {
          if (!candidate.selected) props.controller.togglePortableSkill(candidate.name);
        }
        setPortableToolsOpen(false);
      } };
    const selectionToolActions: ActionItem[] = [
      selectAllPortableCandidates,
      { actionId: 'portable-selection-filter', label: portableSelectionView === 'selected' ? '查看全部候选' : `只看已选（${draft.selectedCount}）`, run: () => {
        setPortableSelectionView((current) => current === 'all' ? 'selected' : 'all');
        setPortableToolsOpen(false);
        setFocus(0);
        setScrollOffset(0);
      } },
      { actionId: 'portable-selection-clear', label: '清空选择', disabled: draft.selectedCount === 0 ? '当前没有已选 Skill' : undefined, run: () => {
        props.controller.clearPortableSkills();
        setPortableToolsOpen(false);
        setFocus(0);
        setScrollOffset(0);
      } },
      ...(plugin.dependencySummary?.totalCount ? [{ actionId: 'portable-selection-dependencies', label: '查看依赖关系', run: () => go({ name: 'portableDependencies', pluginId: plugin.pluginId }) }] : []),
      { actionId: 'portable-selection-tools-back', label: '返回 Skills 列表', run: () => {
        setPortableToolsOpen(false);
        setFocus(0);
        setScrollOffset(0);
      } },
    ];
    const continueAction: ActionItem = { actionId: 'portable-selection-continue', label: `继续（${draft.selectedCount}）`, run: continuePortableSelection };
    const openToolsAction: ActionItem = { actionId: 'portable-selection-tools', label: '选择工具', run: () => {
      setPortableToolsOpen(true);
      setFocusZone('content');
      setFocus(0);
      setScrollOffset(0);
    } };
    pinnedActions = [continueAction, openToolsAction];
    actions = portableToolsOpen ? selectionToolActions : candidateActions;
    const candidateViewport = portableSkillCandidateViewport(
      candidateActions,
      Math.max(20, size.columns - 2),
      policy.mode === 'compact',
      focus,
      scrollOffset,
      pageActionBudget(2 + (portableVariantCandidates.length > 0 ? 3 : 0)),
    );
    const viewport = showTechnical
      ? { offset: focus < visibleCandidates.length ? focus : candidateViewport.offset, limit: 1 }
      : candidateViewport;
    const visibleCandidateEntries = visibleCandidates
      .map((candidate, index) => ({ candidate, action: candidateActions[index]!, index }))
      .slice(viewport.offset, viewport.offset + viewport.limit);
    const variantCandidates = portableVariantCandidates;
    const focusedVariant = variantCandidates.find((candidate) => candidate.name === visibleCandidates[focus]?.name);
    const visibleVariant = visibleCandidateEntries.find((entry) => portableScopeVariantsDiffer(entry.candidate))?.candidate;
    const technicalVariant = focusedVariant ?? visibleVariant ?? variantCandidates[0];
    help = portableToolsOpen
      ? '↑↓ 移动 · Enter 选择 · Tab 返回固定栏 · Esc 返回'
      : focusZone === 'actions'
        ? '←→/↑↓ 移动操作 · Enter 选择 · Tab 返回列表 · c 继续 · Esc 返回'
        : '↑↓ 移动 · Space 切换 · Enter 查看摘要 · Tab 固定栏 · c 继续 · Esc 返回';
    content = <Box flexDirection="column">
      <PinnedActionBar actions={pinnedActions.map((action) => ({
        id: action.actionId!, label: action.label, disabled: Boolean(action.disabled),
      }))} active={!portableEmptySelectionOpen && focusZone === 'actions'} focus={pinnedActionFocus} />
      <ContentViewport>
      {portableToolsOpen
        ? <SemanticRows actions={selectionToolActions} focus={focusZone === 'content' ? focus : -1} kind="action" compact={policy.mode === 'compact'} />
        : visibleCandidateEntries.map(({ action, index }) => <ObjectCardRow
            key={String(action.label)}
            width={Math.max(20, size.columns - 2)}
            title={`${action.selected ? '[x]' : '[ ]'} ${action.label}`}
            description={action.description ?? ''}
            meta={action.meta}
            tags={action.tags}
            focused={!portableEmptySelectionOpen && focusZone === 'content' && focus === index}
            anchored={!portableEmptySelectionOpen && focusZone !== 'content' && focus === index}
            muted={portableEmptySelectionOpen}
            compact={policy.mode === 'compact'}
          />)}
      {!portableToolsOpen && variantCandidates.length > 0
        ? showTechnical
          ? <StaticRow title={`! ${variantCandidates.length} 个 Skill 存在范围变体`} status="warning" compact />
          : <Callout status="warning" title={`! ${variantCandidates.length} 个 Skill 在不同安装范围会生成不同内容。选择范围后会重新确认最终内容。`} />
        : null}
      {!portableToolsOpen && visibleCandidates.length === 0
        ? <StaticRow title="没有已选 Skill" description="选择“查看全部候选”后可继续勾选" status="muted" compact />
        : null}
      {!portableToolsOpen && !draft.canContinue
        ? <StaticRow title="至少选择一个 Skill" status="warning" compact />
        : null}
      {!portableToolsOpen && showTechnical && technicalVariant ? <TechnicalDetails title="范围变体">
        <StaticRow key={`${technicalVariant.name}:project`} title={`${technicalVariant.name} · ${portableScopeVariantLabel('project', technicalVariant.scopeDetails.project)}`} compact />
        <StaticRow key={`${technicalVariant.name}:user`} title={`${technicalVariant.name} · ${portableScopeVariantLabel('user', technicalVariant.scopeDetails.user)}`} compact />
        {variantCandidates.length > 1 ? <StaticRow title={`另有 ${variantCandidates.length - 1} 个 Skill 的范围变体已折叠`} status="muted" compact /> : null}
      </TechnicalDetails> : null}
      </ContentViewport>
    </Box>;
  } else if (route.name === 'portableSkillSummary' && plugin && snapshot.portableDraft) {
    const candidate = snapshot.portableDraft.candidates.find((entry) => entry.name === route.skillName);
    breadcrumb = `${plugin.displayName} / 通用 Skills / 内容摘要`;
    context = candidate?.providerDisplayName ?? plugin.displayName;
    title = candidate?.name ?? 'Skill 不再可用';
    description = candidate?.description ?? '候选已经变化。请返回重新选择。';
    actions = [
      { label: '返回 Skill 选择', run: back },
      { label: '继续选择 Agent', disabled: snapshot.portableDraft.canContinue ? undefined : '至少选择一个 Skill', run: () => go({ name: 'portableAgentMode', pluginId: plugin.pluginId }) },
    ];
    content = <Box flexDirection="column">
      <SectionCard title="内容摘要">
        <StaticRow title="所属插件" meta={candidate?.providerDisplayName ?? '未知'} compact />
        <StaticRow title="生成方式" meta={candidate?.dynamic ? '按当前插件设置生成' : '目录中的静态 Skill'} compact />
        <StaticRow title="可用范围" meta={candidate?.availableScopes.map(scopeLabel).join('、') ?? '未确认'} compact />
      </SectionCard>
      <SemanticRows actions={actions} focus={focus} kind="action" compact={policy.mode === 'compact'} />
    </Box>;
    help = '↑↓ 移动 · Enter 选择 · Esc 返回';
  } else if (route.name === 'portableDependencies' && plugin && snapshot.portableDraft) {
    const overview = dependencyOverview(plugin);
    breadcrumb = `${plugin.displayName} / 通用 Skills / 依赖`;
    context = `${(overview?.summary.totalCount ?? 0) + 1} 个插件`;
    title = '生成这些候选 Skills 需要的插件';
    description = '插件依赖用于生成，不能在这里取消。';
    actions = [
      { label: '返回 Skill 选择', run: back },
      { label: showTechnical ? '隐藏技术详情' : '技术详情', run: () => toggleTechnical() },
    ];
    const dependencies = overview?.dependencies ?? [];
    const visibleDependencies = dependencies.slice(0, showTechnical ? 1 : responsiveBudget(2, 3));
    const technicalDependencies = dependencies.slice(0, 1);
    const compactTechnicalSummary = policy.mode === 'compact' && showTechnical;
    content = <Box flexDirection="column">
      {compactTechnicalSummary ? <SectionCard title="provider 摘要" meta={`${dependencies.length + 1} 个`} compact>
        <StaticRow title={plugin.displayName} meta="根 provider" compact />
        <StaticRow title={`${dependencies.length} 个依赖 providers`} meta="用于生成" compact />
      </SectionCard> : <SectionCard title="当前插件"><StaticRow title={plugin.displayName} description="提供本次安装入口" meta={`提供 ${snapshot.portableDraft.candidates.filter((candidate) => candidate.relation === 'requested').length} 个 Skills`} compact={policy.mode === 'compact'} /></SectionCard>}
      {compactTechnicalSummary ? null : <SectionCard title="依赖插件" meta={`${dependencies.length} 个`}>
        {visibleDependencies.map((dependency) => <StaticRow key={dependency.pluginId} title={dependency.displayName} description={`${dependency.relation === 'direct' ? '当前插件直接需要' : '由依赖插件继续需要'} · ${dependency.requiredBy.map((entry) => entry.displayName).join('、')} 需要它`} meta={`提供 ${snapshot.portableDraft!.candidates.filter((candidate) => candidate.providerPluginId === dependency.pluginId).length} 个 Skills`} compact={policy.mode === 'compact'} />)}
        {dependencies.length > visibleDependencies.length ? <StaticRow title={`另有 ${dependencies.length - visibleDependencies.length} 个依赖插件`} status="muted" compact /> : null}
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
      { label: '指定 Agent', description: '输入一个或多个 Agent ID', selected: snapshot.portableDraft.agentMode === 'explicit', run: () => go({ name: 'portableAgentInput', pluginId: plugin.pluginId }) },
    ];
    content = <SemanticRows actions={actions} focus={focus} kind="choice" compact={policy.mode === 'compact'} />;
  } else if (route.name === 'portableAgentInput' && plugin) {
    breadcrumb = `${plugin.displayName} / 通用 Skills / Agent`;
    context = '指定';
    title = '输入 Agent ID';
    description = '多个 Agent 可使用逗号或空格分隔。';
    help = '输入 Agent ID · Enter 保存 · Ctrl-U 清空输入 · Esc 返回';
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
    const cliUnavailable = route.code === 'portableSkillsCliMissing'
      || route.code === 'portableSkillsCliIncompatible';
    const showPortableRequirements = cliUnavailable && showTechnical;
    if (showPortableRequirements) {
      breadcrumb = `${plugin.displayName} / 通用 Skills / 环境`;
      context = '第 1 / 1 页';
      title = '准备安装工具';
      description = '完成环境准备后返回问题摘要并重新检查。';
    } else {
      title = diagnostic.title;
      description = '';
    }
    actions = showPortableRequirements ? [
      { label: '返回问题摘要', run: () => toggleTechnical() },
    ] : [
      ...(route.code === 'requiredConfigMissing' ? [{ label: '完成插件设置', run: () => {
        props.controller.replace({ name: 'configFields', pluginId: plugin.pluginId, layer: { scope: 'effective' } });
        setFocus(0);
        setScrollOffset(0);
      } }] : []),
      ...(cliUnavailable
        ? [{ label: '查看准备要求', run: () => toggleTechnical() }]
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
      { label: snapshot.installPlacementDraft?.pluginId === plugin.pluginId ? '返回目标平台' : '返回插件详情', run: () => props.controller.resetPortableFlowToPreview(plugin.pluginId) },
      ...(cliUnavailable
        ? []
        : [{ label: showTechnical ? '返回问题摘要' : '技术详情', run: () => toggleTechnical() }]),
    ];
    const blockerActionViewport = actionViewport(actions, policy.mode === 'compact', focus, scrollOffset, responsiveBudget(2, 4));
    content = <Box flexDirection="column">
      {showPortableRequirements ? <>
        <StaticRow title="在 PATH 中提供兼容的 skills 可执行文件。" compact />
        <StaticRow title={`当前 AW adapter 支持：${SKILLS_CLI_SUPPORTED_VERSION_LABEL}`} compact />
        <StaticRow title="准备完成后返回问题摘要并重新检查。" compact />
        <StaticRow title="不会自动运行 npx latest、sudo 或在线安装脚本。" status="warning" compact />
        <StaticRow title="选定插件、安装目标和 Portable 草稿保持不变。" status="success" compact />
        <StaticRow title="AW 不会在此页安装外部依赖。" status="warning" compact />
      </> : <DiagnosticSummary diagnostic={diagnostic} technical={showTechnical} compact={policy.mode === 'compact'} />}
      <SemanticRows actions={actions} focus={focus} kind="action" compact={policy.mode === 'compact'} offset={blockerActionViewport.offset} limit={blockerActionViewport.limit} />
    </Box>;
  } else if (route.name === 'pluginDependencies' && plugin) {
    const overview = dependencyOverview(plugin);
    const visibleDependents = route.view === 'removeBlocked' && route.platform && route.scope
      ? props.controller.getBlockingDependents(plugin.pluginId, route.platform, route.scope)
      : overview?.dependents ?? [];
    const dependencyCount = overview?.dependencies.length ?? 0;
    const dependentCount = visibleDependents.length;
    const dependentLimit = responsiveBudget(1, 3);
    const dependencyRows = (entries: PluginDependencyItemViewModel[], limit: number, dependent = false, offset = 0): React.ReactNode => {
      const safeOffset = Math.min(offset, Math.max(0, entries.length - 1));
      const visible = entries.slice(safeOffset, safeOffset + limit);
      return <>
        {safeOffset > 0 ? <StaticRow title={`↑ 前面还有 ${safeOffset} 项`} status="muted" compact /> : null}
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
        {entries.length > safeOffset + visible.length ? <StaticRow title={`↓ 后面还有 ${entries.length - safeOffset - visible.length} 项`} status="muted" compact /> : null}
      </>;
    };
    if (route.view === 'removeBlocked') {
      breadcrumb = `${plugin.displayName} / 移除`;
      context = '已阻止';
      title = `无法移除 ${plugin.displayName}`;
      description = '仍有插件依赖它。请先处理依赖者，再重新尝试。';
      const blockedRemovalActions: ActionItem[] = [
        { label: '查看完整依赖关系', run: () => {
          props.controller.replace({ name: 'pluginDependencies', pluginId: plugin.pluginId });
          setFocus(0);
          setScrollOffset(0);
        } },
        { label: '返回插件详情', run: back },
        { label: showTechnical ? '隐藏技术详情' : '技术详情', run: () => toggleTechnical() },
      ];
      const blockedRemovalPagination = !showTechnical && visibleDependents.length > dependentLimit
        ? paginationActions({
            offset: batchTargetOffset,
            total: visibleDependents.length,
            pageRows: dependentLimit,
            move: (direction) => moveBatchTargetPage(visibleDependents.length, dependentLimit, direction),
          })
        : [];
      actions = [...blockedRemovalPagination, ...blockedRemovalActions];
      if (blockedRemovalPagination.length > 0) {
        referenceDetailPagination = { total: visibleDependents.length, pageRows: dependentLimit };
      }
      const blockedRemovalViewport = actionViewport(actions, policy.mode === 'compact', focus, scrollOffset, pageActionBudget(5));
      if (!showTechnical && visibleDependents.length > dependentLimit) {
        help = 'p/n 查看全部被依赖关系 · ↑↓ 移动 · Enter 选择 · Esc 返回';
      }
      content = <Box flexDirection="column">
        <StaticRow title={`${dependentCount} 个已安装插件仍在使用`} status="error" compact />
        <StaticRow title="没有修改任何安装。" status="muted" compact />
        {showTechnical ? null : <>
          <StaticRow title="使用这个依赖的插件" meta="反向引用" compact />
          {dependencyRows(visibleDependents, dependentLimit, true, batchTargetOffset)}
        </>}
        <SemanticRows actions={actions} focus={focus} kind="action" compact={policy.mode === 'compact'} offset={blockedRemovalViewport.offset} limit={blockedRemovalViewport.limit} />
        {showTechnical ? <IssueTechnicalDetails details={[{
          code: 'dependencyStillRequired',
          message: '已安装插件仍在使用这个依赖；请先处理依赖者。',
        }]} compact={policy.mode === 'compact'} /> : null}
      </Box>;
    } else {
      breadcrumb = `${plugin.displayName} / 依赖关系`;
      const unified = buildUnifiedDependencyGraphProjection({
        overviews: props.controller.listPluginDependencyOverviews(),
        rootPluginId: plugin.pluginId,
        ...(expandedDependencyPluginIds ? { expandedPluginIds: expandedDependencyPluginIds } : {}),
      });
      const visibleRows = unified.rows;
      context = '上下游';
      title = hasInstalledPlacement(plugin) ? '依赖与当前可用关系' : '安装所需插件';
      description = 'A → B 表示 A 需要 B；当前插件只显示一次。';
      const rowActions: ActionItem[] = visibleRows.map((row) => {
        const state = row.depth === 0
          ? { value: statusText(plugin), status: plugin.aggregateStatus === 'needsAttention'
            ? 'warning' as const
            : plugin.aggregateStatus === 'unavailable' ? 'error' as const
              : plugin.aggregateStatus === 'available' ? 'muted' as const : 'success' as const }
          : dependencyGraphRowStatus(row);
        const branch = row.depth === 0 ? ''
          : `${row.ancestorHasNextSibling.map((next) => next ? '│ ' : '  ').join('')}${row.lastChild ? '└─' : '├─'} `;
        const compactBranch = policy.mode === 'compact' && row.depth > 2 ? '… └─ ' : branch;
        return {
          label: row.depth === 0
            ? `${row.label}（当前插件）`
            : `${row.branch === 'dependents' ? '↑ 使用者 ' : '↓ 所需 '}${compactBranch}${row.label}${row.sharedWithRowId ? '（共用，见上方）' : ''}`,
          description: row.hiddenDescendantCount > 0
            ? `另有 ${row.hiddenDescendantCount} 个${row.branch === 'dependencies' ? '所需插件' : '当前可用使用者'}`
            : row.depth === 0 ? '当前插件 ★'
              : row.branch === 'dependencies' ? '当前插件所需' : '需要当前插件',
          meta: state.value,
          status: state.status,
          run: () => {
            const direction = row.branch === 'dependents' ? 'dependents' : 'dependencies';
            persistUnifiedDependencyGraphContext(
              plugin.pluginId,
              unified,
              expandedDependencyPluginIds ?? new Set([
                ...unified.dependencies.defaultExpandedPluginIds,
                ...unified.dependents.defaultExpandedPluginIds,
              ]),
              focus,
              scrollOffset,
            );
            go({
              name: 'pluginDependencyNode',
              pluginId: plugin.pluginId,
              nodePluginId: row.pluginId,
              direction,
              nodePathPluginIds: row.pathPluginIds,
            });
          },
        };
      });
      const unverifiedConsumerActions: ActionItem[] = unified.dependents.scopeSummary.unknownConsumerPluginIds
        .map((pluginId) => {
            const declared = overview?.dependents.find((entry) => entry.pluginId === pluginId);
            return {
              label: declared?.displayName ?? pluginId,
              description: '有依赖声明，但本次尚未确认依赖可用',
              meta: declared?.aggregateStatus === 'notInstalled' ? '仅声明 · 未安装' : '仅声明 · 未验证',
              status: 'muted' as const,
              run: () => {
                persistUnifiedDependencyGraphContext(
                  plugin.pluginId,
                  unified,
                  expandedDependencyPluginIds ?? new Set([
                    ...unified.dependencies.defaultExpandedPluginIds,
                    ...unified.dependents.defaultExpandedPluginIds,
                  ]),
                  focus,
                  scrollOffset,
                );
                go({
                  name: 'pluginDependencyNode',
                  pluginId: plugin.pluginId,
                  nodePluginId: pluginId,
                  direction: 'dependents',
                });
              },
            };
          });
      actions = [
        ...rowActions,
        ...unverifiedConsumerActions,
        { label: showTechnical ? '隐藏检查详情' : '查看检查详情', run: () => toggleTechnical() },
      ];
      const relationViewport = actionViewport(actions, policy.mode === 'compact', focus,
        scrollOffset, showTechnical ? responsiveBudget(2, 5) : responsiveBudget(5, 9));
      const focusedGraphRow = focus < rowActions.length ? visibleRows[focus] : undefined;
      help = '↑↓ 选择 · → 展开 · ← 收起 · Enter 节点详情 · Esc 返回';
      content = <Box flexDirection="column">
        <StaticRow title="检查范围" value="只检查当前项目和个人位置；其他项目未检查" status="muted" compact />
        {unified.status.state === 'invalid'
          ? <Callout status="error" title="依赖关系无效" description={unified.status.message} /> : null}
        {unverifiedConsumerActions.length > 0
          ? <StaticRow title={`未验证声明者 · ${unverifiedConsumerActions.length} 个`} description="以下声明者不计入当前可用关系" status="muted" compact />
          : null}
        {focusedGraphRow ? <StaticRow title="用途" value={props.controller
          .getPluginOverview(focusedGraphRow.pluginId)?.description ?? '当前目录没有用途说明'} compact /> : null}
        <SemanticRows actions={actions} focus={focus} kind="action" compact
          offset={relationViewport.offset} limit={relationViewport.limit} />
        {showTechnical ? <TechnicalDetails>
          <StaticRow title={`${dependencyCount} 个依赖 · ${unified.dependents.scopeSummary.availableConsumerPluginIds.length} 个当前可用使用者`} meta={plugin.pluginId} compact />
          <StaticRow title={`未验证声明者 · ${unified.dependents.scopeSummary.unknownConsumerPluginIds.length} 个`} compact />
        </TechnicalDetails> : null}
      </Box>;
    }
  } else if (route.name === 'pluginDependencyNode' && plugin) {
    const node = props.controller.getPluginOverview(route.nodePluginId);
    const nodePathPluginIds = route.nodePathPluginIds ?? [plugin.pluginId, route.nodePluginId];
    const nodeProjection = buildDependencyGraphProjection({
      overviews: props.controller.listPluginDependencyOverviews(),
      rootPluginId: plugin.pluginId,
      direction: route.direction,
      expandedPluginIds: nodePathPluginIds,
      focusPluginId: route.nodePluginId,
    });
    const selectedRow = nodeProjection.rows.find((row) =>
      row.pathPluginIds.join('\0') === nodePathPluginIds.join('\0'))
      ?? nodeProjection.rows.find((row) => row.pluginId === route.nodePluginId);
    const item = route.nodePluginId === plugin.pluginId ? undefined
      : (route.direction === 'dependencies'
        ? props.controller.getPluginDependencyOverview(plugin.pluginId)?.dependencies
        : props.controller.getPluginDependencyOverview(plugin.pluginId)?.dependents)
        ?.find((entry) => entry.pluginId === route.nodePluginId);
    const state = item ? dependencyStatus(item) : undefined;
    const relationship = selectedRow?.relationship
      ?? ((item?.availablePlacementReferences?.length ?? 0) > 0 ? 'unknown'
        : item ? 'declared' : undefined);
    breadcrumb = `${plugin.displayName} / 依赖关系 / ${node?.displayName ?? route.nodePluginId}`;
    context = route.direction === 'dependencies' ? '它需要的' : '哪些插件依赖它';
    title = node?.displayName ?? route.nodePluginId;
    const pathPluginIds = selectedRow?.pathPluginIds ?? nodePathPluginIds;
    const intermediateNames = pathPluginIds.slice(1, -1).reverse().map((pluginId) =>
      props.controller.getPluginOverview(pluginId)?.displayName ?? pluginId);
    const declaringPluginId = pathPluginIds.at(-2) ?? plugin.pluginId;
    const declaringPluginName = props.controller.getPluginOverview(declaringPluginId)?.displayName
      ?? declaringPluginId;
    description = relationship === 'root'
      ? '这是当前关系图的根插件。'
      : relationship === 'directAvailable'
        ? route.direction === 'dependencies'
          ? `${plugin.displayName} 在本次检查的位置需要此插件，所需依赖当前可用。`
          : `${node?.displayName ?? route.nodePluginId} 在本次检查的位置需要当前插件，所需依赖当前可用。`
        : relationship === 'indirectAvailable'
          ? route.direction === 'dependencies'
            ? `${plugin.displayName} 通过 ${intermediateNames.join('、')} 需要 ${node?.displayName ?? route.nodePluginId}，且各段依赖当前可用。`
            : `${node?.displayName ?? route.nodePluginId} 通过 ${intermediateNames.join('、')} 需要 ${plugin.displayName}，且各段依赖当前可用。`
          : relationship === 'unknown'
            ? '本次检查的位置不能组成连续路径，不能显示这项间接关系。'
            : relationship === 'declared'
              ? route.direction === 'dependencies'
                ? `${declaringPluginName} 声明需要 ${node?.displayName ?? route.nodePluginId}，但本次尚未确认依赖可用。`
                : `${node?.displayName ?? route.nodePluginId} 声明需要当前插件，但本次尚未确认依赖可用。`
              : '当前数据不足，不能判断这项依赖关系。';
    const references = selectedRow?.edge?.availablePlacementReferences
      ?? item?.availablePlacementReferences ?? [];
    const referenceActions: ActionItem[] = references.map((reference) => {
      const consumerName = props.controller.getPluginOverview(reference.consumer.pluginId)?.displayName
        ?? reference.consumer.pluginId.split('/').at(-1)!;
      return {
        label: dependencyReferenceUsageLabel(reference, consumerName),
        meta: '依赖当前可用',
      };
    });
    if (route.view === 'details') {
      const detailSections = [
        ['用途', node?.description ?? '当前目录没有用途说明'],
        ['为何需要', description],
        ['影响', state?.value ?? (node ? statusText(node) : '尚未检查当前状态')],
      ] as const;
      const detailLines = detailSections.flatMap(([label, value]) => [
        label,
        ...wrapConsoleText(value, Math.max(1, size.columns - 6)).map((line) => `  ${line}`),
      ]);
      const pageRows = Math.max(1, Math.min(
        responsiveBudget(5, 10),
        pageActionBudget(5),
      ));
      const detailOffset = Math.min(batchTargetOffset, Math.max(0, detailLines.length - 1));
      const visibleDetailLines = detailLines.slice(detailOffset, detailOffset + pageRows);
      referenceDetailPagination = { total: detailLines.length, pageRows };
      breadcrumb = `${plugin.displayName} / 依赖关系 / ${node?.displayName ?? route.nodePluginId} / 完整说明`;
      context = `${Math.min(detailOffset + 1, detailLines.length)}–${Math.min(detailOffset + visibleDetailLines.length, detailLines.length)} / ${detailLines.length}`;
      title = `${node?.displayName ?? route.nodePluginId} 的完整说明`;
      description = '用途、关系原因和当前影响。';
      help = 'p/n 或 PgUp/PgDn 阅读 · ↑↓ 移动 · Enter 选择 · Esc 返回节点详情';
      actions = [
        ...paginationActions({
          offset: detailOffset,
          total: detailLines.length,
          pageRows,
          move: (direction) => moveBatchTargetPage(detailLines.length, pageRows, direction),
        }),
        { label: '返回节点详情', run: back },
      ];
      content = <Box flexDirection="column">
        {detailOffset > 0 ? <StaticRow title={`↑ 前面还有 ${detailOffset} 行`} status="muted" compact /> : null}
        {visibleDetailLines.map((line, index) => <StaticRow key={`${detailOffset + index}:${line}`} title={line} compact />)}
        {detailOffset + visibleDetailLines.length < detailLines.length
          ? <StaticRow title={`↓ 后面还有 ${detailLines.length - detailOffset - visibleDetailLines.length} 行`} status="muted" compact /> : null}
        <SemanticRows actions={actions} focus={focus} kind="action" compact />
      </Box>;
    } else if (route.view === 'references') {
      breadcrumb = `${plugin.displayName} / 依赖关系 / ${node?.displayName ?? route.nodePluginId} / 使用位置`;
      context = showTechnical ? '技术详情' : '使用位置';
      title = `当前可用依赖位置 ${references.length} 个`;
      description = showTechnical
        ? '显示当前选择的完整引用字段。'
        : '这些位置的所需依赖当前可用，且本次检查发现它们同时满足依赖声明和安装位置。';
      if (!showTechnical && references[focus]) selectedDependencyReferenceIndex.current = focus;
      const selectedReferenceIndex = Math.min(
        selectedDependencyReferenceIndex.current,
        Math.max(0, references.length - 1),
      );
      const selectedReference = references[selectedReferenceIndex];
      const referenceIdLines = (label: 'consumer' | 'dependency', pluginId: string): string[] => {
        const prefix = `${label} · `;
        return wrapConsoleText(pluginId, Math.max(1, size.columns - 10 - stringWidth(prefix)))
          .map((line) => `${prefix}${line}`);
      };
      const referenceDetailLines = selectedReference ? [
        ...referenceIdLines('consumer', selectedReference.consumer.pluginId),
        `consumer · platform=${platformLabel(selectedReference.consumer.platform)} · scope=${selectedReference.consumer.scope}`,
        `consumer · project=${selectedReference.consumer.project ?? 'none'}`,
        ...referenceIdLines('dependency', selectedReference.dependency.pluginId),
        `dependency · platform=${platformLabel(selectedReference.dependency.platform)} · scope=${selectedReference.dependency.scope}`,
        `dependency · project=${selectedReference.dependency.project ?? 'none'}`,
      ] : [];
      const referenceDetailPageRows = referenceDetailLines.length <= 6
        ? 6
        : responsiveBudget(4, 8);
      const referenceDetailOffset = Math.min(batchTargetOffset,
        Math.max(0, referenceDetailLines.length - 1));
      const visibleReferenceDetailLines = referenceDetailLines.slice(
        referenceDetailOffset,
        referenceDetailOffset + referenceDetailPageRows,
      );
      referenceDetailPagination = showTechnical ? {
        total: referenceDetailLines.length,
        pageRows: referenceDetailPageRows,
      } : undefined;
      const referencePaginationActions = showTechnical
        && referenceDetailLines.length > referenceDetailPageRows
        ? paginationActions({
            offset: referenceDetailOffset,
            total: referenceDetailLines.length,
            pageRows: referenceDetailPageRows,
            move: (direction) => moveBatchTargetPage(
              referenceDetailLines.length, referenceDetailPageRows, direction),
          })
        : [];
      actions = [
        ...(showTechnical && referenceActions[selectedReferenceIndex]
          ? [referenceActions[selectedReferenceIndex]] : referenceActions),
        ...referencePaginationActions,
        { label: '返回节点详情', run: back },
      ];
      const referenceViewport = actionViewport(actions, policy.mode === 'compact', focus, scrollOffset,
        responsiveBudget(3, 6));
      help = showTechnical
        ? 'p/n 查看当前位置详情 · ↑↓ 移动 · Enter 选择 · d 隐藏技术详情 · Esc 返回节点详情'
        : '↑↓ 查看全部位置 · d 技术详情 · Enter 返回节点详情 · Esc 返回节点详情';
      content = <Box flexDirection="column">
        {showTechnical ? null
          : <StaticRow title="本次检查" value="只检查当前项目和个人位置；其他项目未检查" status="muted" compact />}
        {showTechnical && referenceDetailOffset > 0
          ? <StaticRow title={`↑ 前面还有 ${referenceDetailOffset} 行`} status="muted" compact /> : null}
        {showTechnical ? visibleReferenceDetailLines.map((line, index) =>
          <StaticRow key={`${referenceDetailOffset + index}:${line}`} title={line} compact />) : null}
        {showTechnical && referenceDetailOffset + visibleReferenceDetailLines.length < referenceDetailLines.length
          ? <StaticRow title={`↓ 后面还有 ${referenceDetailLines.length - referenceDetailOffset - visibleReferenceDetailLines.length} 行`} status="muted" compact /> : null}
        <SemanticRows actions={actions} focus={focus} kind="action" compact
          offset={referenceViewport.offset} limit={referenceViewport.limit} />
      </Box>;
    } else {
      actions = [
        ...(references.length > 0 ? [{
          label: `查看全部位置（${references.length}）`,
          description: '查看每个位置的当前可用依赖',
          run: () => go({ ...route, view: 'references' }),
        }] : []),
        ...(route.nodePluginId !== plugin.pluginId ? [{
          label: '以此节点查看关系',
          description: '打开局部子树；面包屑保留来路',
          run: () => go({
            name: 'pluginDependencies',
            pluginId: route.nodePluginId,
            direction: route.direction,
          }),
        }] : []),
        {
          label: '阅读完整说明',
          description: '分页查看用途、为何需要和影响',
          run: () => {
            setBatchTargetOffset(0);
            go({ ...route, view: 'details' });
          },
        },
        { label: '返回关系图', run: back },
      ];
      const nodeActionViewport = actionViewport(actions, policy.mode === 'compact', focus,
        scrollOffset, responsiveBudget(2, 4));
      content = <Box flexDirection="column">
        <SectionCard title="节点状态">
          <StaticRow title="用途" value={node?.description ?? '当前目录没有用途说明'} compact />
          <StaticRow title="为何需要" value={description} compact />
          <StaticRow title="影响" value={state?.value ?? (node ? statusText(node) : '尚未检查当前状态')}
            status={state?.status ?? 'muted'} compact />
          {references.length > 0
            ? <StaticRow title={`当前可用依赖位置 ${references.length} 个`} description="选择“查看全部位置”可逐项查看" compact />
            : null}
        </SectionCard>
        <SemanticRows actions={actions} focus={focus} kind="action" compact={policy.mode === 'compact'}
          offset={nodeActionViewport.offset} limit={nodeActionViewport.limit} />
        {showTechnical ? <TechnicalDetails>
          <StaticRow title="pluginId" meta={route.nodePluginId} compact />
          <StaticRow title="relationship" meta={relationship ?? 'unknown'} compact />
        </TechnicalDetails> : null}
      </Box>;
    }
  } else if (route.name === 'installTargets' && plugin) {
    breadcrumb = `${plugin.displayName} / 添加 / 目标平台`;
    context = '第 1 步，共 2 步';
    title = '选择目标平台';
    description = 'Codex 与 Claude Code 可以同时选择。通用 Agent Skills 使用独立安装流程。';
    const choices = (['codex', 'claude'] as const).map((platform) => {
      const scopes = (['project', 'user'] as const).filter((candidateScope) =>
        props.controller.listInstallTargets(plugin.pluginId, candidateScope)
          .some((entry) => entry.platform === platform && entry.compatible));
      const evidence = (['project', 'user'] as const).flatMap((candidateScope) =>
        props.controller.listInstallTargets(plugin.pluginId, candidateScope)
          .filter((entry) => entry.platform === platform));
      return {
        platform,
        compatible: scopes.length > 0,
        scopes,
        disabled: scopes.length > 0 ? undefined
          : evidence.find((entry) => entry.disabled)?.disabled ?? '没有可信且兼容的缺失位置',
      };
    });
    const selectedNativeTargets = snapshot.installPlacementDraft?.pluginId === plugin.pluginId
      ? snapshot.installPlacementDraft.platforms
      : selectedTargets;
    const validSelectedTargets = selectedNativeTargets.filter((platform) =>
      choices.some((choice) => choice.platform === platform && choice.compatible));
    const allUnavailable = choices.every((choice) => !choice.compatible) && !plugin.portableSkills;
    if (route.view === 'blocked' || allUnavailable) {
      context = '依赖限制';
      title = '无法添加到所选目标平台';
      description = '根插件或必需依赖不支持当前目标平台组合，因此不会进入确认页。';
      actions = [
        { label: '查看依赖关系', run: () => go({ name: 'pluginDependencies', pluginId: plugin.pluginId }) },
        { label: '返回插件详情', run: back },
      ];
      content = <Box flexDirection="column"><StatusCard status="warning" title="所选目标平台不可用">{choices.map((choice) => <StaticRow key={choice.platform} title={`${platformLabel(choice.platform)} · ${choice.disabled ? `不可选 · ${choice.disabled}` : '不可选'}`} status="muted" compact={policy.mode === 'compact'} />)}</StatusCard><SemanticRows actions={actions} focus={focus} kind="action" compact={policy.mode === 'compact'} /></Box>;
    } else {
      const confirmNativePlatforms = (): void => {
        if (validSelectedTargets.length === 0) {
          setActionError('请至少选择一个目标平台。');
          return;
        }
        setDirty(false);
        props.controller.setInstallPlatforms(validSelectedTargets);
        go({ name: 'installPlacement', pluginId: plugin.pluginId });
      };
      const nativeActions: ActionItem[] = choices.map((choice) => {
        const installed = installedScopeStates(plugin, choice.platform);
        const configuredScopes = plugin.supportedScopes?.[choice.platform];
        const supportedScopes = (['project', 'user'] as const).filter((candidateScope) =>
          configuredScopes?.includes(candidateScope)
          || installed.has(candidateScope) || choice.scopes.includes(candidateScope));
        const locationItems = supportedScopes.map((candidateScope) => {
          const state = installed.get(candidateScope);
          if (state) return {
            key: `${choice.platform}:${candidateScope}`,
            label: scopeLabel(candidateScope),
            symbol: state.symbol,
            status: state.status,
          };
          return choice.scopes.includes(candidateScope)
            ? { key: `${choice.platform}:${candidateScope}`, label: scopeLabel(candidateScope),
                symbol: '○' as const, status: 'muted' as const }
            : { key: `${choice.platform}:${candidateScope}`, label: scopeLabel(candidateScope),
                symbol: '?' as const, status: 'muted' as const };
        });
        const missingLabels = choice.scopes.filter((candidateScope) => !installed.has(candidateScope))
          .map(scopeLabel);
        return {
          actionId: `install-platform-${choice.platform}`,
          label: platformLabel(choice.platform),
          selected: validSelectedTargets.includes(choice.platform),
          description: choice.disabled ? `不可选择：${choice.disabled}` : (missingLabels.length > 0
            ? `可添加到：${missingLabels.join('、')}` : '所有支持位置已经安装'),
          status: choice.disabled ? 'muted' : undefined,
          tags: locationItems.length > 0 ? <StatusBadge items={locationItems} /> : undefined,
          run: () => {
            if (!choice.compatible) return;
            setActionError(undefined);
            setSelectedTargets((current) => {
              const next = current.includes(choice.platform)
                ? current.filter((platform) => platform !== choice.platform)
                : [...current, choice.platform];
              props.controller.setInstallPlatforms(next);
              return next;
            });
          },
        };
      });
      const portableAction: ActionItem = {
        actionId: 'portable-agent-skills',
        label: '通用 Agent Skills →',
        description: plugin.portableSkills
          ? '通过外部 Skills CLI 安装到支持的 Agent；只安装选定 Skills'
          : '这个插件不提供通用 Agent Skills',
        status: plugin.portableSkills ? undefined : 'muted',
        tags: plugin.portableSkills
          ? <Text color={tuiTheme.colors.accent}>[Skills 可选]</Text>
          : undefined,
        run: () => {
          if (!plugin.portableSkills) return;
          beginPortable(plugin.pluginId);
        },
      };
      const confirmAction: ActionItem = {
        actionId: 'confirm-install-platforms',
        label: '确定所选平台',
        disabled: validSelectedTargets.length === 0 ? '至少选择一个目标平台' : undefined,
        run: confirmNativePlatforms,
      };
      const backAction: ActionItem = {
        actionId: 'install-platforms-back', label: '返回插件详情', run: back,
      };
      actions = [...nativeActions, portableAction];
      pinnedActions = [confirmAction, backAction];
      const cardWidth = Math.max(20, size.columns - 2);
      const installTargetStaticRows = (validSelectedTargets.length === 0 ? 2 : 1)
        + (policy.mode === 'compact' ? 4 : 0);
      const platformViewport = objectCardActionViewport(actions, cardWidth,
        policy.mode === 'compact', focus, scrollOffset,
        Math.max(1, pageActionBudget(installTargetStaticRows)));
      help = '↑↓ 移动 · Enter/Space 勾选平台 · Enter 打开通用 Skills · Tab 操作栏 · c 继续 · Esc 返回';
      content = <Box flexDirection="column">
        <PinnedActionBar actions={pinnedActions.map((action) => ({
          id: action.actionId!, label: action.label, disabled: Boolean(action.disabled),
        }))} active={focusZone === 'actions'} focus={pinnedActionFocus} />
        {validSelectedTargets.length === 0
          ? <Text color={tuiTheme.colors.muted}>至少选择一个目标平台</Text> : null}
        <ContentViewport>
          {actions.slice(platformViewport.offset, platformViewport.offset + platformViewport.limit)
            .map((action, visibleIndex) => <ObjectCardRow
              key={action.actionId}
              width={cardWidth}
              title={action.actionId?.startsWith('install-platform-')
                ? `${action.selected ? '[x]' : '[ ]'} ${action.label}` : action.label}
              description={action.disabled ?? action.description ?? ''}
              tags={action.tags}
              focused={focusZone === 'content' && platformViewport.offset + visibleIndex === focus}
              anchored={focusZone !== 'content' && platformViewport.offset + visibleIndex === focus}
              compact={policy.mode === 'compact'}
            />)}
        </ContentViewport>
      </Box>;
    }
  } else if (route.name === 'installPlacement' && plugin) {
    breadcrumb = `${plugin.displayName} / 添加 / 使用范围`;
    context = '第 2 步，共 2 步';
    title = `你希望在哪里使用 ${plugin.displayName}？`;
    const hasDependencies = (plugin.dependencySummary?.totalCount ?? 0) > 0;
    const selectedPlatforms = snapshot.installPlacementDraft?.platforms ?? selectedTargets;
    const legalScopes = (platform: PlatformName): Scope[] => (['project', 'user'] as const).filter((candidateScope) =>
      props.controller.listInstallTargets(plugin.pluginId, candidateScope)
        .some((entry) => entry.platform === platform && entry.compatible));
    const commonScopes = (['project', 'user'] as const).filter((candidateScope) =>
      selectedPlatforms.every((platform) => legalScopes(platform).includes(candidateScope)));
    const continueCommonScope = async (candidateScope: Scope): Promise<void> => {
      setScope(candidateScope);
      props.controller.setInstallRootScope(candidateScope);
      props.controller.setInstallPlatforms(selectedPlatforms);
      if (hasDependencies) {
        const configurable = await props.controller.prepareInstallDependencyPlacement();
        if (configurable) {
          go({ name: 'dependencyPlacement', pluginId: plugin.pluginId });
          return;
        }
      }
      beginReview(props.controller.installPlacementIntent());
    };
    if (commonScopes.length > 0) {
      description = '所选平台使用同一个范围。操作汇总会显示实际目标和依赖计划。';
      actions = commonScopes.map((candidateScope) => ({
        label: scopeLabel(candidateScope),
        description: candidateScope === 'user'
          ? '在任意项目中可用，会改变你的用户环境'
          : '仅供当前项目使用，适合随项目共享',
        meta: candidateScope === 'project' ? '推荐' : undefined,
        run: () => continueCommonScope(candidateScope),
      }));
    } else {
      description = '所选平台没有共同范围。请分别确定每个平台的合法位置。';
      const pairActions = selectedPlatforms.flatMap((platform) => legalScopes(platform).map((candidateScope) => ({
        label: `${platformLabel(platform)} · ${scopeLabel(candidateScope)}`,
        selected: installPlatformScopes[platform] === candidateScope,
        run: () => setInstallPlatformScopes((current) => ({ ...current, [platform]: candidateScope })),
      })));
      const exactTargets = selectedPlatforms.flatMap((platform) => installPlatformScopes[platform]
        ? [{ pluginId: plugin.pluginId, platform, scope: installPlatformScopes[platform]! }] : []);
      actions = [
        ...pairActions,
        {
          label: '继续到操作汇总',
          description: '只安装上方明确选择的实际目标',
          disabled: exactTargets.length !== selectedPlatforms.length ? '请为每个平台选择一个位置' : undefined,
          run: () => beginReview({
            kind: 'pluginWriteBatch',
            action: 'install',
            selection: { kind: 'targets', targets: exactTargets },
            platform: new Set(exactTargets.map((target) => target.platform)).size > 1
              ? 'both' : exactTargets[0]!.platform,
            scope: exactTargets[0]!.scope,
          }),
        },
        { label: '返回目标平台', run: back },
      ];
    }
    const scopeChoiceCount = commonScopes.length > 0 ? actions.length : Math.max(0, actions.length - 2);
    content = <Box flexDirection="column">
      <SemanticRows actions={actions} focus={focus} kind={commonScopes.length > 0 ? 'choice' : 'toggle'} compact={policy.mode === 'compact'} limit={scopeChoiceCount} />
      {commonScopes.length === 0
        ? <SemanticRows actions={actions} focus={focus} kind="action" compact={policy.mode === 'compact'} offset={scopeChoiceCount} />
        : null}
      {hasDependencies ? <Callout title="依赖计划" description="所需插件会自动安排；确认前可查看影响。" /> : null}
    </Box>;
    help = '↑↓ 移动 · Enter 选择/继续 · Esc 返回';
  } else if (route.name === 'uninstallTargets' && plugin) {
    breadcrumb = `${plugin.displayName} / 卸载`;
    context = '实际安装位置';
    title = '选择要卸载的位置';
    description = '只处理本页列出的实际安装位置。插件设置默认保留。';
    const targets = props.controller.listPluginWriteBatchTargets('uninstall', [plugin.pluginId]);
    const keyFor = (target: PluginWriteBatchTarget): string =>
      [target.pluginId, target.platform, target.scope].join('\0');
    const selected = targets.filter((target) => uninstallTargetKeys.includes(keyFor(target)));
    const blocked = selected.filter((target) =>
      props.controller.getBlockingDependents(target.pluginId, target.platform, target.scope).length > 0);
    const targetActions: ActionItem[] = targets.map((target) => ({
      label: `${platformLabel(target.platform)} · ${scopeLabel(target.scope)}`,
      selected: uninstallTargetKeys.includes(keyFor(target)),
      description: props.controller.getBlockingDependents(target.pluginId, target.platform, target.scope).length > 0
        ? '仍有已确认的依赖者使用这个位置'
        : '实际安装位置；配置保持不变',
      status: props.controller.getBlockingDependents(target.pluginId, target.platform, target.scope).length > 0
        ? 'warning' : undefined,
      run: () => setUninstallTargetKeys((current) => current.includes(keyFor(target))
        ? current.filter((key) => key !== keyFor(target))
        : [...current, keyFor(target)]),
    }));
    actions = [
      ...targetActions,
      {
        actionId: 'uninstall-all-targets',
        label: '全部已安装位置',
        selected: selected.length === targets.length,
        run: () => setUninstallTargetKeys(
          selected.length === targets.length ? [] : targets.map(keyFor),
        ),
      },
      {
        label: '继续到卸载确认',
        description: selected.length > 0 ? `${selected.length} 个精确目标；保留插件设置` : undefined,
        disabled: selected.length === 0 ? '请至少选择一个位置'
          : blocked.length > 0 ? '所选位置仍有依赖者' : undefined,
        status: 'error',
        run: () => {
          if (selected.length === 1) {
            const target = selected[0]!;
            beginPluginRemoval(plugin, target.platform, target.scope);
            return;
          }
          beginReview({
            kind: 'pluginWriteBatch',
            action: 'uninstall',
            selection: { kind: 'targets', targets: selected },
            platform: new Set(selected.map((target) => target.platform)).size > 1
              ? 'both' : selected[0]!.platform,
            scope: selected[0]!.scope,
          });
        },
      },
      { label: '返回插件详情', run: back },
    ];
    content = <Box flexDirection="column">
      <SemanticRows actions={actions} focus={focus} kind="toggle" compact={policy.mode === 'compact'} limit={targetActions.length + 1} />
      <SemanticRows actions={actions} focus={focus} kind="action" compact={policy.mode === 'compact'} offset={targetActions.length + 1} />
    </Box>;
    help = '↑↓ 移动 · Enter 选择/继续 · Esc 返回';
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
      meta: `${scopeLabel(target.scope)}${target.assignmentSource === 'consumerPromotion' ? ' · 因依赖自动调整' : ''}`,
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
        description: draft?.canContinue ? '使用这些最终位置显示操作汇总' : undefined,
        disabled: !draft?.canContinue ? draft?.error?.message ?? '依赖位置尚未就绪' : undefined,
        run: () => beginReview(props.controller.installPlacementIntent()),
      },
      {
        label: '恢复推荐位置',
        description: '恢复依赖自动安排的建议位置',
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
      ...(defaultCount > 0 ? [`默认当前项目 ${defaultCount} 项`] : []),
      ...(reusedCount > 0 ? [`复用健康的所有项目安装 ${reusedCount} 项`] : []),
      ...(promotedCount > 0 ? [`因依赖自动调整 ${promotedCount} 项`] : []),
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
      const unavailable = !target?.allowedScopes.includes(candidateScope);
      return {
        label: scopeLabel(candidateScope),
        selected: target?.scope === candidateScope,
        description: candidateScope === 'user'
          ? '更宽：对其他项目可见，并会改变你的用户环境'
          : '仅供当前项目使用；适合随项目共享',
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
        ? <Callout status="warning" title="依赖需要更大使用范围" description={`上游依赖需要至少使用${scopeLabel(target.minimumScope)}。`} />
        : null}
      <SemanticRows actions={actions} focus={focus} kind="choice" compact={policy.mode === 'compact'} />
    </Box>;
    help = '↑↓ 移动 · Enter 选择 · Esc 返回';
  } else if (route.name === 'pluginWriteTask' && plugin) {
    const retainedTargetKeys = route.targetKeys ? new Set(route.targetKeys) : undefined;
    const allTaskCandidates = props.controller.listPluginWriteTaskCandidates(route.goal);
    const currentTargetKeys = new Set(allTaskCandidates.map(pluginWriteTaskTargetKey));
    const missingTargetKeys = route.targetKeys?.filter((targetKey) => !currentTargetKeys.has(targetKey)) ?? [];
    const recommendedPluginIds = route.recommendedPluginIds
      ? new Set(route.recommendedPluginIds) : undefined;
    const addedTargetKeys = retainedTargetKeys && recommendedPluginIds
      ? allTaskCandidates.filter((candidate) =>
        recommendedPluginIds.has(candidate.target.pluginId)
        && !retainedTargetKeys.has(pluginWriteTaskTargetKey(candidate)))
        .map(pluginWriteTaskTargetKey)
      : [];
    const targetSetChanged = missingTargetKeys.length > 0 || addedTargetKeys.length > 0;
    const candidates: PluginWriteTaskCandidate[] = allTaskCandidates
      .filter((candidate) => retainedTargetKeys
        ? retainedTargetKeys.has(pluginWriteTaskTargetKey(candidate))
        : candidate.target.pluginId === route.pluginId);
    const executable = candidates.filter((candidate) => candidate.eligible);
    const blockedCandidates = candidates.filter((candidate) => !candidate.eligible);
    const taskPluginIds = [...new Set(candidates.map((candidate) => candidate.target.pluginId))];
    const currentVersionEvidence = Object.assign({}, ...taskPluginIds.map((pluginId) => {
      const candidatePlugin = props.controller.getPluginOverview(pluginId);
      return candidatePlugin ? pluginWriteTaskVersionEvidence(
        candidatePlugin,
        candidates.filter((candidate) => candidate.target.pluginId === pluginId),
      ) : {};
    }));
    const versionEvidenceChanged = route.goal === 'update' && route.versionEvidence !== undefined
      && (Object.entries(currentVersionEvidence).some(([key, version]) => route.versionEvidence?.[key] !== version)
        || Object.keys(route.versionEvidence).some((key) => currentVersionEvidence[key] === undefined));
    const activationSources = [...new Set(blockedCandidates
      .filter((candidate) => candidate.blockReason === 'catalogActivationRequired')
      .map((candidate) => candidate.sourceId))];
    const taskIssues = new Map(props.controller.listUserIssues().map((issue) => [issue.issueId, issue]));
    const recoveryActions = [...new Map(blockedCandidates.flatMap((candidate): Array<[string, ActionItem]> => {
      if (candidate.blockReason === 'catalogActivationRequired') return [];
      const target = candidate.target;
      const targetLabel = `${candidate.displayName} · ${platformLabel(target.platform)} · ${scopeLabel(target.scope)}`;
      const linkedIssue = candidate.issueIds.map((issueId) => taskIssues.get(issueId)).find(Boolean);
      const sourceIssue = linkedIssue && (linkedIssue.group === 'sourceRemoved'
        || linkedIssue.group === 'sourceUnavailable')
        ? linkedIssue
        : [...taskIssues.values()].find((entry) =>
            (entry.category === 'sourceUnavailable' || entry.category === 'sourceMissing'
              || entry.category === 'sourceIdentityChanged')
            && (entry.sourceId === candidate.sourceId || entry.pluginId === target.pluginId));
      const issue = linkedIssue ?? sourceIssue;
      const candidatePlugin = props.controller.getPluginOverview(target.pluginId);
      const configField = issue?.requiredFields?.[0];
      if (issue?.group === 'config' || configField) {
        const fieldKey = configField?.key;
        return [[`config:${target.pluginId}:${fieldKey ?? ''}`, {
          label: fieldKey ? `完成设置：${configField?.title ?? fieldKey}` : `检查 ${candidate.displayName} 的设置`,
          description: `${targetLabel}；保存后返回任务重新读取当前证据`,
          status: 'warning',
          run: () => {
            beginConfigFlow(target.pluginId);
            props.controller.replace({
              name: 'configFields',
              pluginId: target.pluginId,
              layer: { scope: 'effective' },
            });
          },
        }]];
      }
      if (candidate.blockReason === 'restoreVersionChanged') {
        const updateCandidates = props.controller.listPluginWriteTaskCandidates('update')
          .filter((entry) => pluginWriteTaskTargetKey(entry) === pluginWriteTaskTargetKey(candidate));
        const updatePlugin = props.controller.getPluginOverview(target.pluginId);
        if (updateCandidates.length > 0 && updatePlugin) {
          return [[`update:${pluginWriteTaskTargetKey(candidate)}`, {
            label: `更新并恢复 ${targetLabel}`,
            description: '改用当前候选版本建立新任务；显示操作汇总前仍会重新检查状态',
            status: 'warning',
            run: () => props.controller.beginNestedPluginWriteTask({
              name: 'pluginWriteTask',
              pluginId: target.pluginId,
              goal: 'update',
              targetKeys: updateCandidates.map(pluginWriteTaskTargetKey),
              ...(route.batchOrigin ? { batchOrigin: route.batchOrigin } : {}),
              versionEvidence: pluginWriteTaskVersionEvidence(updatePlugin, updateCandidates),
            }),
          }]];
        }
      }
      if (sourceIssue || candidatePlugin?.sourceUnavailable) {
        const sourceId = sourceIssue?.sourceId ?? candidate.sourceId;
        const sourceNeedsIssue = sourceIssue?.category === 'sourceMissing'
          || sourceIssue?.category === 'sourceIdentityChanged'
          || sourceIssue?.group === 'sourceRemoved';
        if (sourceNeedsIssue && sourceIssue) {
          return [[`source-issue:${sourceIssue.issueId}`, {
            label: sourceIssue.category === 'sourceMissing'
              ? `重新添加来源 ${sourceId}` : `核对来源身份 ${sourceId}`,
            description: `${targetLabel}；先查看来源问题的安全恢复选择`,
            status: 'warning',
            run: () => go({ name: 'issueDetail', issueId: sourceIssue.issueId }),
          }]];
        }
        return [[`source:${sourceId}`, {
          label: `核对来源 ${sourceId}`,
          description: `${targetLabel}；修复或重新检查后返回任务`,
          status: 'warning',
          run: () => go({ name: 'sourceDetail', sourceId }),
        }]];
      }
      if (candidate.blockReason === 'restoreVersionUnverified'
        || candidate.blockReason === 'updateEvidenceIncomplete') {
        return [
          [`reload:${pluginWriteTaskTargetKey(candidate)}`, {
            label: `重新检查 ${targetLabel}`,
            description: '重新读取安装、版本、来源和受管内容证据',
            run: async () => {
              await props.controller.load();
              setFocus(0);
              setScrollOffset(0);
            },
          }],
          [`diagnostic:${pluginWriteTaskTargetKey(candidate)}`, {
            label: `查看 ${targetLabel} 的诊断`,
            description: '版本仍无法确认时查看组件状态和安全恢复方向',
            run: () => go({ name: 'pluginTechnical', pluginId: target.pluginId }),
          }],
        ];
      }
      if (issue) {
        return [[`issue:${issue.issueId}`, {
          label: `处理问题：${issue.title}`,
          description: `${targetLabel}；只提供该问题允许的恢复动作`,
          status: 'warning',
          run: () => go({ name: 'issueDetail', issueId: issue.issueId }),
        }]];
      }
      if (candidate.blockReason === 'targetUnavailable'
        || candidate.blockReason === 'manualRecoveryRequired'
        || candidate.blockReason === 'taskActionConflict') {
        return [[`maintenance:${pluginWriteTaskTargetKey(candidate)}`, {
          label: `维护 ${targetLabel}`,
          description: '检查这个精确平台位置可用的安全维护动作',
          status: 'warning',
          run: () => go({ name: 'platform', pluginId: target.pluginId, platform: target.platform }),
        }]];
      }
      return [[`diagnostic:${target.pluginId}`, {
        label: `查看 ${candidate.displayName} 的诊断`,
        description: `${pluginWriteTaskBlockLabel(candidate.blockReason)}；当前没有可安全自动执行的动作`,
        run: () => go({ name: 'pluginTechnical', pluginId: target.pluginId }),
      }]];
    })).values()];
    const taskLabel = pluginWriteTaskLabel(route.goal);
    const startTaskReview = (executionPolicy: 'all' | 'executableSubset'): void => {
      if (targetSetChanged) {
        setActionError('本次安装位置已变化。请返回调整后重新开始。');
        return;
      }
      props.controller.startPluginWriteTaskReview({
        kind: 'pluginWriteTask',
        goal: route.goal,
        targets: candidates.map((candidate) => candidate.target),
        executionPolicy,
      }, props.controller.pluginWriteTaskReturnRoute(route));
      setFocus(0);
      setScrollOffset(0);
    };
    breadcrumb = taskPluginIds.length > 1
      ? `我的插件 / ${taskLabel} ${taskPluginIds.length} 个插件`
      : `我的插件 / ${plugin.displayName} / ${taskLabel}`;
    context = '只读准备';
    title = taskPluginIds.length > 1
      ? `${taskLabel} ${taskPluginIds.length} 个插件`
      : `${taskLabel} ${plugin.displayName}`;
    description = route.goal === 'update'
      ? '只使用已验证的插件版本和精确安装位置。来源目录不会在准备时自动启用。'
      : '根据当前问题选择最小恢复方法，不自动改版本、位置或来源。';
    help = candidates.length > (policy.mode === 'compact' ? 3 : 6)
      ? 'PgUp/PgDn 查看全部位置 · ↑↓ 移动 · Enter 选择 · Esc 返回'
      : '↑↓ 移动 · Enter 选择 · Esc 返回';
    actions = [
      ...(!targetSetChanged && !versionEvidenceChanged
        && blockedCandidates.length === 0 && executable.length > 0 ? [{
        label: `确认${taskLabel} ${executable.length} 个位置`,
        description: '进入统一影响确认；执行前再次检查当前证据',
        status: 'success' as const,
        run: () => startTaskReview('all'),
      }] : []),
      ...(!targetSetChanged && !versionEvidenceChanged
        && blockedCandidates.length > 0 && executable.length > 0 ? [{
        label: `先处理可执行的 ${executable.length} 个位置`,
        description: `${blockedCandidates.length} 个受阻位置保留，不会无声跳过`,
        status: 'warning' as const,
        run: () => startTaskReview('executableSubset'),
      }] : []),
      ...activationSources.map((sourceId) => ({
        label: `先更新来源目录 ${sourceId}`,
        description: '先单独确认目录变更；启用完成后重新准备插件更新',
        status: 'warning' as const,
        run: () => beginReview({ kind: 'catalogGeneration', action: 'update', sourceId }),
      })),
      ...recoveryActions,
      ...(versionEvidenceChanged ? [{
        label: '使用当前版本重新准备',
        description: '来源启用后的插件版本与先前候选不同；先明确采用当前版本',
        status: 'warning' as const,
        run: () => {
          props.controller.replace({ ...route, versionEvidence: currentVersionEvidence });
          setFocus(0);
          setScrollOffset(0);
        },
      }] : []),
      { label: route.recommendedPluginIds ? '返回调整选择' : '返回插件详情', run: back },
    ];
    const taskTargetLimit = policy.mode === 'compact' ? 3 : 6;
    const taskTargetOffset = Math.min(batchTargetOffset, Math.max(0, candidates.length - 1));
    const visibleTaskCandidates = candidates.slice(taskTargetOffset, taskTargetOffset + taskTargetLimit);
    const targetRows = visibleTaskCandidates.map((candidate) => {
      const target = candidate.target;
      const version = target.expectedUpdate
        ? `${target.expectedUpdate.installedVersion} → ${target.expectedUpdate.activeVersion}`
        : '保持当前版本';
      return <StaticRow
        key={`${target.pluginId}:${target.platform}:${target.scope}`}
        title={`${taskPluginIds.length > 1 ? `${candidate.displayName} · ${candidate.sourceId} · ` : ''}${platformLabel(target.platform)} · ${scopeLabel(target.scope)}${!candidate.eligible && policy.mode === 'compact'
          ? ` · ${pluginWriteTaskBlockLabel(candidate.blockReason)}` : ''}`}
        description={candidate.eligible
          ? pluginWriteTaskMethodLabel(candidate.recommendedMethod)
          : pluginWriteTaskBlockLabel(candidate.blockReason)}
        meta={candidate.eligible ? version : '需要决定'}
        status={candidate.eligible ? 'success' : 'warning'}
        compact={policy.mode === 'compact'}
      />;
    });
    const taskViewport = actionViewport(actions, policy.mode === 'compact', focus, scrollOffset,
      pageActionBudget(Math.min(candidates.length, policy.mode === 'compact' ? 3 : 6) + 2));
    content = <Box flexDirection="column">
      <SectionCard title="处理范围" meta={`${executable.length} 个可执行 · ${blockedCandidates.length} 个需决定`} compact={policy.mode === 'compact'}>
        {taskTargetOffset > 0 ? <StaticRow title={`↑ 前面还有 ${taskTargetOffset} 个位置`} status="muted" compact /> : null}
        {targetRows.length > 0 ? targetRows
          : <StaticRow title="当前没有可执行目标" status="muted" compact />}
        {candidates.length > taskTargetOffset + targetRows.length
          ? <StaticRow title={`↓ 后面还有 ${candidates.length - taskTargetOffset - targetRows.length} 个位置`} status="muted" compact /> : null}
      </SectionCard>
      {blockedCandidates.length > 0 ? <Callout status="warning" title={`${blockedCandidates.length} 个位置需要先处理或决定`} description={executable.length > 0
        ? '可以先处理可执行项，或进入下方对应入口处理受阻位置。'
        : '请进入下方对应入口处理；返回后会重新读取当前证据。'} compact={policy.mode === 'compact'} /> : null}
      {missingTargetKeys.length > 0 ? <Callout status="warning"
        title={`${missingTargetKeys.length} 个本次安装位置已失效或无需处理`}
        description="不会把这些位置当作已完成，也不会自动缩小本次范围。请返回调整选择后重新开始。"
        compact={policy.mode === 'compact'} /> : null}
      {addedTargetKeys.length > 0 ? <Callout status="warning"
        title={`${addedTargetKeys.length} 个新位置需要重新确认`}
        description="不会把刷新后新增的位置自动加入本次操作。请返回调整选择后重新开始。"
        compact={policy.mode === 'compact'} /> : null}
      {versionEvidenceChanged ? <Callout status="warning" title="插件目标版本已变化" description="不会沿用来源启用前的版本证据，也不会自动执行新版本。" compact={policy.mode === 'compact'} /> : null}
      <SemanticRows actions={actions} focus={focus} kind="action" compact offset={taskViewport.offset} limit={taskViewport.limit} />
    </Box>;
  } else if (route.name === 'pluginDetail' && plugin) {
    breadcrumb = `插件 / ${plugin.displayName}`;
    context = `${plugin.sourceLabel}${plugin.version ? ` · ${plugin.version}` : ''}`;
    title = plugin.displayName;
    description = '';
    const updateDescription = pluginUpdateDescription(plugin);
    const installedVersions = [...new Set((plugin.update?.targets ?? [])
      .flatMap((target) => target.installedVersion ? [target.installedVersion] : []))];
    const versionSummary = installedVersions.length > 1
      ? `各平台版本不同：${installedVersions.join('、')}`
      : installedVersions.length === 1
        ? plugin.version && plugin.version !== installedVersions[0]
          ? `${installedVersions[0]} → ${plugin.version}`
          : `已安装 ${installedVersions[0]}`
        : plugin.version ? `可安装版本 ${plugin.version}` : '版本待确认';
    context = `${plugin.sourceLabel} · ${versionSummary}`;
    const updateTaskCandidates: PluginWriteTaskCandidate[] = plugin.configOnly ? []
      : props.controller.listPluginWriteTaskCandidates('update')
        .filter((candidate) => candidate.target.pluginId === plugin.pluginId);
    const restoreTaskCandidates: PluginWriteTaskCandidate[] = plugin.configOnly ? []
      : props.controller.listPluginWriteTaskCandidates('restore')
        .filter((candidate) => candidate.target.pluginId === plugin.pluginId);
    const updateAction: ActionItem | undefined = updateTaskCandidates.length > 0 ? {
        label: updateTaskCandidates.length === 1 && updateTaskCandidates[0]?.target.expectedUpdate
          ? `更新到 ${updateTaskCandidates[0].target.expectedUpdate.activeVersion}`
          : updateTaskCandidates.some((candidate) => candidate.target.expectedUpdate)
            ? `更新 ${plugin.displayName}` : '准备插件更新',
        description: updateTaskCandidates.some((candidate) => candidate.blockReason === 'catalogActivationRequired')
          ? '需要先单独确认来源目录变更' : '使用精确版本和现有安装位置',
        status: 'warning',
        run: () => go({
          name: 'pluginWriteTask', pluginId: plugin.pluginId, goal: 'update',
          targetKeys: updateTaskCandidates.map(pluginWriteTaskTargetKey),
          versionEvidence: pluginWriteTaskVersionEvidence(plugin, updateTaskCandidates),
        }),
      } : undefined;
    const executableRestoreCandidates = restoreTaskCandidates.filter((candidate) => candidate.eligible);
    const restoreAction: ActionItem | undefined = executableRestoreCandidates.length > 0 ? {
        label: '恢复正常',
        description: `${restoreTaskCandidates.length} 个现有位置需要检查`,
        status: 'warning',
        run: () => go({
          name: 'pluginWriteTask', pluginId: plugin.pluginId, goal: 'restore',
          targetKeys: restoreTaskCandidates.map(pluginWriteTaskTargetKey),
        }),
      } : undefined;
    const settingsAction: ActionItem | undefined = plugin.configFieldCount > 0
      || plugin.savedConfigScopes.length > 0 ? {
          label: plugin.configOnly ? '查看已保存设置' : '插件设置',
          description: plugin.configOnly
            ? '检查已保存设置，并可重置记录中的设置层'
            : '查看当前实际生效的配置和值来源',
          meta: plugin.configFieldCount > 0 ? `${plugin.configFieldCount} 项配置` : undefined,
          run: () => {
            if (plugin.configOnly) props.controller.beginSavedConfigRecovery(plugin.pluginId);
            else beginConfigFlow(plugin.pluginId);
            setFocus(0);
            setScrollOffset(0);
          },
        } : undefined;
    const issuesForPlugin = props.controller.listUserIssues().filter((candidate) =>
      issueMatchesTarget(candidate, plugin.pluginId));
    const configIssue = issuesForPlugin.find((candidate) => candidate.group === 'config');
    const exceptionalAction: ActionItem | undefined = configIssue ? {
        label: '查看处理建议',
        description: '当前插件设置问题需要先完成或修正设置',
        status: 'warning',
        run: () => go({ name: 'issueDetail', issueId: configIssue.issueId }),
      } : plugin.aggregateStatus === 'unavailable'
      ? plugin.capabilityUnsupported && !plugin.sourceUnavailable ? {
          label: '需要升级 AW CLI',
          description: '查看缺少的功能和安全恢复方向',
          status: 'warning',
          run: () => go({ name: 'pluginTechnical', pluginId: plugin.pluginId }),
        } : {
          label: '恢复插件来源',
          description: '来源恢复后再重新检查插件状态',
          status: 'warning',
          run: () => go({ name: 'sourceDetail', sourceId: plugin.sourceId }),
        }
      : plugin.aggregateStatus === 'needsAttention' && !restoreAction
        && (!updateAction || issuesForPlugin.length > 0) ? {
          label: '查看处理建议',
          description: '当前问题需要先确认原因或处理方式',
          status: 'warning',
          run: () => issuesForPlugin.length === 1
            ? go({ name: 'issueDetail', issueId: issuesForPlugin[0]!.issueId })
            : issuesForPlugin.length > 1
              ? go({ name: 'issueList' })
              : go({ name: 'pluginTechnical', pluginId: plugin.pluginId }),
        } : undefined;
    const installed = hasInstalledPlacement(plugin);
    const hasInstallableTarget = props.controller.pluginHasInstallableTarget(plugin.pluginId);
    const hasInstallationOption = hasInstallableTarget || plugin.portableSkills;
    const beginInstall = (): void => {
      const initialScope = (['user', 'project'] as const).find((candidateScope) =>
        props.controller.listInstallTargets(plugin.pluginId, candidateScope)
          .some((entry) => entry.compatible)) ?? scope;
      const compatible = props.controller.listInstallTargets(plugin.pluginId, initialScope)
        .some((entry) => entry.compatible);
      setScope(initialScope);
      setSelectedTargets([]);
      setInstallPlatformScopes({});
      props.controller.beginInstallFlow(plugin.pluginId, initialScope);
      go(compatible || plugin.portableSkills
        ? { name: 'installTargets', pluginId: plugin.pluginId }
        : { name: 'installTargets', pluginId: plugin.pluginId, view: 'blocked' });
    };
    const installAction: ActionItem | undefined = !plugin.configOnly ? {
      actionId: 'install',
      label: installed ? '安装到其他位置' : '安装',
      description: plugin.sourceUnavailable
        ? '插件来源不可用'
        : plugin.capabilityUnsupported
          ? '当前 AW CLI 不支持这个插件'
          : !hasInstallationOption
            ? '当前工具和插件没有可用的安装方式'
          : '选择工具和使用范围',
      ...(plugin.sourceUnavailable || plugin.capabilityUnsupported || !hasInstallationOption
        ? { disabled: plugin.sourceUnavailable ? '插件来源不可用'
          : plugin.capabilityUnsupported ? '需要升级 AW CLI' : '没有可用的安装方式' }
        : { run: beginInstall }),
    } : undefined;
    const contentOverview = props.controller.getPluginContentOverview(plugin.pluginId);
    const contentAction: ActionItem | undefined = !plugin.configOnly ? {
      actionId: 'content',
      label: '内容详情',
      description: contentOverview
        ? `${contentOverview.items.length} 项目录内容 · 版本 ${contentOverview.pluginVersion}`
        : '打开时读取当前目录版本的内容',
      run: () => go({ name: 'pluginContent', pluginId: plugin.pluginId }),
    } : undefined;
    const dependencyOverviewForDetail = dependencyOverview(plugin);
    const dependencyAction: ActionItem | undefined = dependencyOverviewForDetail
      && (dependencyOverviewForDetail.dependencies.length > 0
        || dependencyOverviewForDetail.dependents.length > 0
        || dependencyOverviewForDetail.blockers.length > 0) ? {
          actionId: 'dependencies',
          label: '依赖关系',
          description: '在同一关系图中查看使用者和所需插件',
          run: () => go({ name: 'pluginDependencies', pluginId: plugin.pluginId }),
        } : undefined;
    const uninstallAction: ActionItem | undefined = installed ? {
      actionId: 'uninstall',
      label: '卸载',
      description: plugin.installedPlacements.length === 1
        ? '打开现有安装位置并确认卸载范围'
        : '选择一个现有平台和实际安装位置',
      status: 'error',
      run: () => {
        const targets = props.controller.listPluginWriteBatchTargets('uninstall', [plugin.pluginId]);
        if (targets.length === 1) {
          const target = targets[0]!;
          beginPluginRemoval(plugin, target.platform, target.scope);
          return;
        }
        setUninstallTargetKeys(targets.map((target) => [target.pluginId, target.platform, target.scope].join('\0')));
        go({ name: 'uninstallTargets', pluginId: plugin.pluginId });
      },
    } : undefined;
    actions = dedupeActions([
      ...(exceptionalAction ? [{ ...exceptionalAction, actionId: 'exceptional' }] : []),
      ...(restoreAction ? [{ ...restoreAction, actionId: 'restore' }] : []),
      ...(updateAction ? [{ ...updateAction, actionId: 'update' }] : []),
      ...(installAction ? [installAction] : []),
      ...(settingsAction ? [{ ...settingsAction, actionId: 'settings' }] : []),
      ...(contentAction ? [contentAction] : []),
      ...(dependencyAction ? [dependencyAction] : []),
      ...(uninstallAction ? [uninstallAction] : []),
      {
        actionId: 'more',
        label: '更多操作',
        description: '平台维护、来源和诊断',
        run: () => go({ name: 'pluginMore', pluginId: plugin.pluginId }),
      },
    ]);
    const dependencyDetailText = dependencyOverviewForDetail
      && dependencyOverviewForDetail.summary.totalCount > 0
      ? `需要 ${dependencyOverviewForDetail.summary.totalCount} 个插件；当前可用关系按当前范围检查，未显示的关系尚未检查通过。`
      : undefined;
    const detailPositions = plugin.installedPlacements
      .filter((placement) => placement.state !== 'notInstalled')
      .map((placement) => `${platformLabel(placement.platform)}：${pluginPlacementConclusions(placement).map((entry) => entry.text).join(' · ')}`);
    const detailSummary = [`${plugin.description}`, `版本 ${plugin.version ?? '未知'} · ${plugin.sourceLabel}`,
      ...detailPositions].join('\n');
    const detailSummaryLines = objectCardRowLayout({
      description: detailSummary, width: size.columns - 2, hasTags: true,
    }).descriptionLines;
    const detailExtraRows = (updateDescription ? 1 : 0) + (dependencyDetailText ? 1 : 0)
      + (snapshot.completionNotice?.pluginId === plugin.pluginId ? 4 : 0);
    const detailPageRows = Math.max(1, pageActionBudget(detailExtraRows + 4 + 3));
    const detailOffset = Math.min(batchTargetOffset, Math.max(0, detailSummaryLines.length - 1));
    const visibleDetailLines = detailSummaryLines.slice(detailOffset, detailOffset + detailPageRows);
    if (detailSummaryLines.length > detailPageRows) {
      context += ` · 摘要 ${detailOffset + 1}–${detailOffset + visibleDetailLines.length}/${detailSummaryLines.length}`;
      actions.push(...paginationActions({
        offset: detailOffset, total: detailSummaryLines.length, pageRows: detailPageRows,
        move: (direction) => moveBatchTargetPage(detailSummaryLines.length, detailPageRows, direction),
      }));
      referenceDetailPagination = { total: detailSummaryLines.length, pageRows: detailPageRows };
    }
    currentActionViewportLineBudget = pageActionBudget(detailExtraRows + 4 + visibleDetailLines.length);
    const detailViewport = actionViewport(actions, true, focus, scrollOffset,
      currentActionViewportLineBudget);
    content = <Box flexDirection="column">
      {snapshot.completionNotice?.pluginId === plugin.pluginId
        ? <Callout status="success" title={snapshot.completionNotice.title}
            description={snapshot.completionNotice.description} />
        : null}
      <ObjectCardRow width={size.columns - 2}
        title={plugin.displayName} description={visibleDetailLines.join('\n')}
        tags={pluginPlatformBadges(plugin)} />
      {updateDescription
        ? <StaticRow title="有可用更新" meta={updateDescription} status="warning" compact />
        : null}
      {dependencyDetailText ? <StaticRow
        title={dependencyDetailText}
        status="muted"
        compact
      /> : null}
      <SemanticRows actions={actions} focus={focus} kind="action" compact
        offset={detailViewport.offset} limit={detailViewport.limit} />
    </Box>;
  } else if (route.name === 'pluginMore' && plugin) {
    breadcrumb = `插件 / ${plugin.displayName} / 更多操作`;
    context = plugin.sourceLabel;
    title = '更多操作';
    description = '选择平台可使用同步、重新安装、移除和受限清理。';
    const dependencySummary = plugin.dependencySummary;
    const detailMenu = buildPluginDetailActions(plugin);
    const updateTaskCandidates = props.controller.listPluginWriteTaskCandidates('update')
      .filter((candidate) => candidate.target.pluginId === plugin.pluginId);
    const restoreTaskCandidates = props.controller.listPluginWriteTaskCandidates('restore')
      .filter((candidate) => candidate.target.pluginId === plugin.pluginId);
    actions = [
      ...(updateTaskCandidates.length > 0 ? [{
        label: '更新插件',
        description: '使用精确版本和现有安装位置',
        status: 'warning' as const,
        run: () => go({
          name: 'pluginWriteTask', pluginId: plugin.pluginId, goal: 'update',
          targetKeys: updateTaskCandidates.map(pluginWriteTaskTargetKey),
          versionEvidence: pluginWriteTaskVersionEvidence(plugin, updateTaskCandidates),
        }),
      }] : []),
      ...(restoreTaskCandidates.length > 0 ? [{
        label: '恢复正常',
        description: `${restoreTaskCandidates.length} 个现有位置需要检查`,
        status: 'warning' as const,
        run: () => go({
          name: 'pluginWriteTask', pluginId: plugin.pluginId, goal: 'restore',
          targetKeys: restoreTaskCandidates.map(pluginWriteTaskTargetKey),
        }),
      }] : []),
      ...detailMenu.filter((action) => action.id !== 'refreshAndSync' && action.id !== 'about')
        .map((action): ActionItem => {
          if (action.id === 'platform' || action.id === 'scopeConflict') {
            const placement = plugin.installedPlacements.find((entry) => entry.platform === action.platform)!;
            const projected = placementStatus(placement);
            return {
              label: `${platformLabel(action.platform)} 平台与维护`,
              description: `${projected.description}；同步、重装、移除和清理入口`,
              meta: projected.value,
              status: projected.status,
              run: () => action.id === 'scopeConflict'
                ? go({ name: 'issueDetail', issueId: `scope:${plugin.pluginId}:${action.platform}` })
                : go({ name: 'platform', pluginId: plugin.pluginId, platform: action.platform }),
            };
          }
          if (action.id === 'resolveScopeConflict') return {
            label: `处理 ${platformLabel(action.platform)} 位置冲突`,
            description: action.description,
            status: 'error',
            run: () => beginScopeConflictRecovery(action),
          };
          if (action.id === 'dependencies') return {
            label: '依赖与当前可用关系',
            description: dependencySummary?.issueCount ? `${dependencySummary.issueCount} 项需要处理` : '查看完整关系',
            meta: dependencySummary ? dependencySummaryText(dependencySummary) : undefined,
            run: () => go({ name: 'pluginDependencies', pluginId: plugin.pluginId }),
          };
          if (action.id === 'settings') return {
            label: plugin.configOnly ? '查看已保存设置' : '插件设置',
            run: () => plugin.configOnly
              ? props.controller.beginSavedConfigRecovery(plugin.pluginId)
              : beginConfigFlow(plugin.pluginId),
          };
          if (action.id === 'sourceProblem') return {
            label: '恢复插件来源', status: 'warning',
            run: () => go({ name: 'sourceDetail', sourceId: plugin.sourceId }),
          };
          if (action.id === 'upgradeAwCli' || action.id === 'capabilityTechnical') return {
            label: action.id === 'upgradeAwCli' ? '升级 AW CLI' : '查看功能支持详情',
            status: action.id === 'upgradeAwCli' ? 'warning' : undefined,
            run: () => go({ name: 'pluginTechnical', pluginId: plugin.pluginId }),
          };
          return {
            label: '查看插件详情',
            run: () => go({ name: 'pluginTechnical', pluginId: plugin.pluginId }),
          };
        }),
      ...(!detailMenu.some((action) => action.id === 'dependencies') ? [{
        label: '依赖与当前可用关系',
        description: '查看必需依赖、声明者和当前可用关系；当前没有声明的必需依赖',
        run: () => go({ name: 'pluginDependencies', pluginId: plugin.pluginId }),
      }] : []),
      { label: '插件定义信息', run: () => go({ name: 'pluginAbout', pluginId: plugin.pluginId }) },
      { label: '查看插件来源', run: () => go({ name: 'sourceDetail', sourceId: plugin.sourceId }) },
      { label: '诊断与受管内容', description: '查看组件状态和安全错误代码', run: () => go({ name: 'pluginTechnical', pluginId: plugin.pluginId }) },
    ];
    const moreViewport = actionViewport(actions, policy.mode === 'compact', focus, scrollOffset, pageActionBudget(1));
    content = <SemanticRows actions={actions} focus={focus} kind="action" compact={policy.mode === 'compact'} offset={moreViewport.offset} limit={moreViewport.limit} />;
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
    const capabilityUnavailable = plugin.capabilityUnsupported && !plugin.sourceUnavailable;
    const sourceIssue = plugin.aggregateStatus === 'unavailable' && !capabilityUnavailable
      ? props.controller.listUserIssues().find((candidate) =>
          candidate.entity.kind === 'source' && candidate.sourceId === plugin.sourceId)
      : undefined;
    const platformAction = (action: PluginMenuAction): ActionItem => {
      if (action.id === 'upgradeAwCli') return {
        label: '升级 AW CLI',
        description: '升级到支持此插件的 AW CLI 版本后重试',
        status: 'warning',
        run: () => go({ name: 'pluginTechnical', pluginId: plugin.pluginId }),
      };
      if (action.id === 'capabilityTechnical') return {
        label: '查看功能支持详情',
        description: '查看缺少的功能和安全恢复方向',
        run: () => go({ name: 'pluginTechnical', pluginId: plugin.pluginId }),
      };
      if (action.id === 'sourceProblem') return { label: '查看来源问题', description: `${plugin.sourceId} 当前不可用`, run: () => go({ name: 'issueDetail', issueId: `source:${plugin.sourceId}:unavailable` }) };
      if (action.id === 'refreshSource') return { label: '获取或修复来源', description: '在 TUI 中验证候选并启用', run: () => go({ name: 'sourceDetail', sourceId: plugin.sourceId }) };
      if (action.id === 'add') return { label: `添加到 ${platformLabel(route.platform)}`, description: '选择使用位置', run: () => {
        const initialScope = placement?.state === 'notInstalled'
          ? placement.supportedScopes[0] ?? scope
          : scope;
        setScope(initialScope);
        setSelectedTargets([route.platform]);
        props.controller.beginInstallFlow(plugin.pluginId, initialScope);
        props.controller.setInstallPlatforms([route.platform]);
        go({ name: 'installTargets', pluginId: plugin.pluginId });
      } };
      if (action.id === 'addScope') return {
        label: `在${scopeLabel(action.scope)}中启用`,
        description: '增加这个使用位置；已被其它项目共用的内容保持不变',
        run: () => beginSecondScope(plugin, action.platform, action.scope),
      };
      if (action.id === 'about') return { label: '查看支持信息', description: '插件定义与平台支持', run: () => go({ name: 'pluginAbout', pluginId: plugin.pluginId }) };
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
        label: `保留${scopeLabel(action.keepScope)}，移除${scopeLabel(action.scope)} root`,
        description: action.description,
        status: 'error',
        run: () => beginScopeConflictRecovery(action),
      };
      if (action.id === 'refreshAndSync') return {
        label: `更新到 ${action.availableVersion}`,
        description: '使用当前启用目录中的已确认版本',
        run: () => beginReview({
          kind: 'pluginWrite', action: 'sync', pluginId: plugin.pluginId,
          platform: action.platform, scope: action.scope,
          expectedUpdate: {
            installedVersion: action.installedVersion,
            activeVersion: action.availableVersion,
            sourceIdentity: action.sourceIdentity,
            generationKey: action.generationKey,
          },
        }),
      };
      if (action.id === 'sync') return {
        label: `同步${scopeLabel(action.scope)}的使用位置`,
        description: placement?.state === 'installed'
          ? (placement.scopedPlacements?.find((entry) => entry.scope === action.scope)?.recovery
            ?? placement.recovery)?.find((entry) => entry.command === 'sync')?.description
            ?? '重新检查已保存位置，并在操作汇总中显示需要处理的项目'
          : undefined,
        run: () => placement?.state === 'installed'
          ? beginReview({ kind: 'pluginWrite', action: 'sync', pluginId: plugin.pluginId, platform: action.platform, scope: action.scope })
          : undefined,
      };
      if (action.id === 'reinstall') return { label: `重新安装${scopeLabel(action.scope)}位置`, description: '保留现有设置并重新生成受管内容', run: () => beginReview({ kind: 'pluginWrite', action: 'reinstall', pluginId: plugin.pluginId, platform: action.platform, scope: action.scope }) };
      if (action.id === 'remove') return { label: `从${scopeLabel(action.scope)}移除`, description: '保留插件设置', status: 'error', run: () => beginPluginRemoval(plugin, action.platform, action.scope) };
      if (action.id === 'cleanup') return { label: `清理${scopeLabel(action.scope)}中的遗留内容`, description: '先核验，再取消此位置的使用设置，并尽力清理可验证的 AW 内容', status: 'error', run: () => beginReview({ kind: 'pluginWrite', action: 'cleanup', pluginId: plugin.pluginId, platform: action.platform, scope: action.scope }) };
      if (action.id === 'technical') return typedIssue
        ? { label: '查看对应问题', description: typedIssue.explanation, run: () => go({ name: 'issueDetail', issueId: typedIssue.issueId }) }
        : { label: placement?.state === 'installed' && placement.health === 'error' ? '查看安全技术详情' : placement?.state === 'installed' && placement.health === 'incomplete' ? '查看影响' : '查看安装详情', description: '组件与诊断信息', run: () => go({ name: 'pluginTechnical', pluginId: plugin.pluginId }) };
      return { label: '返回插件', run: back };
    };
    const offlineCleanupAction = typedIssue?.actions.find((action) => action.id === 'cleanup');
    const offlineCleanup = typedIssue !== undefined
      && placement?.state === 'installed'
      && placement.blockingReason === undefined
      && (placement.actualState === 'orphaned' || placement.actualState === 'blocked')
      && offlineCleanupAction !== undefined
      && !platformMenu.some((action) => action.id === 'cleanup')
      && !platformMenu.some((action) => action.id === 'resolveScopeConflict')
      ? {
          label: `清理${scopeLabel(placement.scope)}中的遗留内容`,
          description: '先核验，再取消此位置的使用设置，并尽力清理可验证的 AW 内容；恢复需单独确认重新安装。',
          status: 'error' as const,
          run: () => {
            const intent = issueWriteIntent(typedIssue, offlineCleanupAction);
            if (intent) beginReview(intent);
          },
        }
      : undefined;
    const restrictedForceCleanup = placement?.state === 'installed'
      && placement.blockingReason === undefined
      && (placement.actualState === 'orphaned' || placement.actualState === 'blocked')
      && !platformMenu.some((action) => action.id === 'resolveScopeConflict')
      ? {
          label: '检查受限清理',
          description: '只在当前单一位置能确认内容只属于此插件时提供；先核验，再取消使用设置并尽力清理；被共用或不属于插件的内容保留。',
          status: 'warning' as const,
          run: () => beginRestrictedForceCleanup(
            plugin.pluginId,
            route.platform,
            placement.scope,
          ),
        }
      : undefined;
    const platformActions = (): ActionItem[] => [
      ...platformMenu.map(platformAction),
      ...(offlineCleanup ? [offlineCleanup] : []),
      ...(restrictedForceCleanup ? [restrictedForceCleanup] : []),
    ];
    breadcrumb = `${plugin.displayName} / ${platformLabel(route.platform)}`;
    const installedPlacementRows = placement?.state === 'installed' ? <>
      <StaticRow title="已保存位置" meta={placement.desiredScopes?.map(scopeLabel).join('、') || '无'} compact />
      <StaticRow title="当前位置" meta={placement.actualScopes?.map(scopeLabel).join('、') || '未启用'} compact />
      <StaticRow
        title="状态"
        meta={placement.actualState === 'ready' ? '可用'
          : placement.actualState === 'needsSync'
            ? placement.sharedNative?.reason === 'outdated'
              ? placement.revision.state === 'upgradeAvailable' ? '有更新' : '版本待同步'
              : '需要同步'
            : placement.actualState === 'blocked' ? '已阻断'
              : placement.health === 'incomplete' ? '需要处理' : '暂时不可用'}
        status={placement.actualState === 'ready' ? 'success' : placement.actualState === 'blocked' ? 'error' : 'warning'}
        compact
      />
      {placement.health !== 'ready'
        ? <StaticRow title="原因" meta={placement.blockingReason === 'artifactCollision'
          ? '输出位置存在冲突内容'
          : placement.sharedNative?.reason === 'outdated'
            ? '已安装版本与当前 Catalog 版本不一致'
            : typedIssue?.explanation ?? '安装状态需要同步，请查看问题详情'} status="warning" compact />
        : null}
    </> : null;
    if (plugin.aggregateStatus === 'unavailable') {
      const sourceOverview = capabilityUnavailable ? undefined : props.controller.getSourceOverview(plugin.sourceId);
      const diagnostic = capabilityUnavailable
        ? capabilityDiagnostic(plugin)
        : sourceIssue?.diagnostic ?? sourceDiagnostic(
          plugin.sourceId,
          sourceOverview?.health?.state ?? sourceOverview?.source?.state,
          sourceOverview?.detail,
        );
      title = capabilityUnavailable
        ? `需要升级 AW CLI 才能管理 ${platformLabel(route.platform)}`
        : `暂时无法管理 ${platformLabel(route.platform)}`;
      description = '';
      actions = platformActions();
      content = <Box flexDirection="column">{diagnostic
        ? <DiagnosticSummary diagnostic={diagnostic} compact={policy.mode === 'compact'} />
        : null}<SemanticRows actions={actions} focus={effectiveFocus} kind="action" compact={policy.mode === 'compact'} /></Box>;
    } else if (!placement || placement.state === 'notInstalled') {
      title = `尚未添加到 ${platformLabel(route.platform)}`;
      description = '此插件支持所列使用位置。';
      actions = platformActions();
      content = <Box flexDirection="column"><StatusCard status="muted" title="未添加" description="插件设置保持不变" /><SemanticRows actions={actions} focus={effectiveFocus} kind="action" compact={policy.mode === 'compact'} /></Box>;
    } else if (placement.state === 'blocked'
      || placement.state === 'installed' && placement.blockingReason === 'artifactCollision') {
      title = `${platformLabel(route.platform)} 无法添加`;
      description = placement.state === 'installed'
        ? '受管内容仍可安全移除；输出位置同时存在冲突内容。'
        : '输出位置已有不属于当前插件的内容。';
      actions = platformActions();
      content = <Box flexDirection="column"><StatusCard status="error" title="输出冲突" description="AW 不会覆盖或删除占用内容" /><SemanticRows actions={actions} focus={effectiveFocus} kind="action" compact={policy.mode === 'compact'} /></Box>;
    } else if (placement.state === 'scopeConflict') {
      title = '安装位置冲突';
      description = '正常状态只能保留一个位置。';
      actions = platformActions();
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
      actions = platformActions();
      content = <Box flexDirection="column"><DiagnosticSummary diagnostic={diagnostic} compact={policy.mode === 'compact'} /><SemanticRows actions={actions} focus={effectiveFocus} kind="action" compact={policy.mode === 'compact'} /></Box>;
    } else if (placement.health === 'incomplete') {
      const issue = props.controller.listUserIssues().find((candidate) =>
        candidate.pluginId === plugin.pluginId
        && candidate.platform === route.platform
        && candidate.scope === placement.scope);
      title = issue?.title ?? `${platformLabel(route.platform)} 状态待同步`;
      description = issue?.explanation ?? '现场状态与期望状态不一致，需要重新检查并同步。';
      actions = platformActions();
      const actualTitle = placement.actualState === 'needsSync' ? '需要同步'
        : placement.actualState === 'blocked' ? '当前有安全阻断' : '需要处理';
      content = <Box flexDirection="column"><StatusCard status={placement.actualState === 'blocked' ? 'error' : 'warning'} title={actualTitle} description={`${scopeLabel(placement.scope)} · ${plugin.sourceLabel}`}>{installedPlacementRows}</StatusCard><SemanticRows actions={actions} focus={effectiveFocus} kind="action" compact={policy.mode === 'compact'} /></Box>;
    } else {
      title = `已安装到${scopeLabel(placement.scope)}`;
      const installedVersion = placement.revision.installedVersion;
      description = `当前检查正常${installedVersion ? `；已安装版本 ${installedVersion}` : ''}。`;
      actions = platformActions();
      content = <Box flexDirection="column"><StatusCard status="success" title="状态正常" description={`${scopeLabel(placement.scope)}${installedVersion ? ` · 已安装版本 ${installedVersion}` : ''}`}>{installedPlacementRows}</StatusCard><SemanticRows actions={actions} focus={effectiveFocus} kind="action" compact={policy.mode === 'compact'} /></Box>;
    }
  } else if (route.name === 'configLayer' && plugin) {
    breadcrumb = `${plugin.displayName} / 设置`;
    const configLayerDefinitionPage = configPage ?? configLayerPages.user ?? configLayerPages.project;
    const selectedField = route.fieldKey && configLayerDefinitionPage
      ? configLayerDefinitionPage.groups.flatMap((group) => group.fields).find((field) => field.key === route.fieldKey)
      : undefined;
    const selectedPreset = route.presetId && configLayerDefinitionPage
      ? configLayerDefinitionPage.presets.find((preset) => preset.id === route.presetId)
      : undefined;
    const selectedMutation = selectedField && configCandidate
      ? configCandidate.mutations[selectedField.key]
      : undefined;
    const candidateSummary = selectedField && selectedMutation
      ? selectedMutation.kind === 'unset' ? '恢复继承'
        : selectedField.sensitive ? '已更新'
          : typeof selectedMutation.value === 'object'
            ? objectSummary(selectedField, selectedMutation.value)
            : scalarSummary(selectedField, selectedMutation.value)
      : selectedPreset && configCandidate
        ? `方案“${selectedPreset.title}” · ${Object.keys(configCandidate.mutations).length} 项修改`
        : undefined;
    const candidateSummaryLines = candidateSummary
      ? wrapConsoleText(candidateSummary, Math.max(12, size.columns - 14))
      : [];
    const candidateSummaryDisplay = candidateSummaryLines.length > 1
      ? `${candidateSummaryLines[0]}…`
      : candidateSummaryLines[0];
    title = selectedField ? `“${selectedField.title}”保存到哪里？`
      : selectedPreset ? `“${selectedPreset.title}”保存到哪里？` : '这个值保存到哪里？';
    description = selectedField
      ? `${selectedField.sensitive ? '敏感值只能保存到个人设置。' : '选择后回到分组总览；磁盘尚未改变。'}`
      : selectedPreset ? '选择后回到分组总览；磁盘尚未改变。' : '请返回重新选择值。';
    if (configActionError) description = configActionError;
    help = '↑↓ 移动 · Enter 选择 · Esc 返回修改值';
    const canUseLayer = (scope: Scope): boolean => {
      const page = configLayerPages[scope];
      if (!page || !configCandidate) return false;
      const fields = page.groups.flatMap((group) => group.fields);
      return Object.entries(configCandidate.mutations).every(([key, mutation]) => {
        const field = fields.find((candidate) => candidate.key === key);
        return Boolean(field && (mutation.kind === 'set' ? configFieldCanSet(field) : configFieldCanUnset(field)));
      });
    };
    actions = [
      ...(canUseLayer('project') ? [{
        label: '当前项目',
        description: '修改仅对当前项目生效；适合随仓库共享的约定',
        meta: configLayerCounts.project === undefined ? undefined : `${configLayerCounts.project} 个值`,
        run: () => openConfigLayerTarget({ scope: 'project' }),
      }] : []),
      ...(canUseLayer('user') ? [{
        label: '个人默认',
        description: '影响个人的所有项目；项目设置仍可覆盖',
        meta: configLayerCounts.user === undefined ? undefined : `${configLayerCounts.user} 个值`,
        run: () => openConfigLayerTarget({ scope: 'user' }),
      }] : []),
    ];
    content = actions.length > 0
      ? <Box flexDirection="column">
          {candidateSummaryDisplay ? <StatusCard status="info" title="已确定新值"
            description={`新值：${candidateSummaryDisplay}`} compact /> : null}
          <SemanticRows actions={actions} focus={focus} kind="section" compact={policy.mode === 'compact'} />
        </Box>
      : <StatusCard status="info" title="正在检查可用保存位置" />;
  } else if (route.name === 'configFields' && plugin) {
    const readonly = false;
    breadcrumb = `${plugin.displayName} / 设置`;
    title = '插件设置';
    description = '先编辑值，再选择保存位置。Tab 可选择完整分组。';
    if (configActionError) description = configActionError;
    help = '↑↓ 移动 · Enter 修改 · Tab 固定操作 · ←→ 分组 · s 查看保存汇总 · u 恢复继承 · Esc 返回';
    if (!currentConfigPage) {
      content = <StatusCard status="info" title="正在读取插件设置"><ProgressRow title="读取设置字段" state="active" /></StatusCard>;
    } else {
      visibleConfigTabs = configTabs(currentConfigPage);
      const requestedTab = snapshot.router.current.context.configGroupId;
      const activeTab = visibleConfigTabs.find((tab) => tab.id === requestedTab) ?? visibleConfigTabs[0];
      activeConfigTabId = activeTab?.id;
      const activeGroup = activeTab?.kind === 'group'
        ? currentConfigPage.groups.find((group) => group.id === activeTab.id)
        : undefined;
      if (configDraftIssues.length > 0) {
        description += ` 有 ${configDraftIssues.length} 项未保存修改已不适用于当前设置。`;
      }
      const mutableLayer = { scope: 'effective' as const };
      const tabActions: ActionItem[] = activeTab?.kind === 'presets'
        ? currentConfigPage.presets.map((preset) => ({
            label: preset.title,
            description: (preset.privateFieldTitles?.length ?? 0) > 0
              ? `${preset.description ? `${preset.description} · ` : ''}${preset.privateFieldTitles!.join('、')}需手动输入`
              : preset.description,
            run: () => applyConfigPreset(currentConfigPage, preset.id),
          }))
        : (activeGroup?.fields ?? []).filter((field) => readonly || configFieldCanSet(field) || configFieldCanUnset(field)).map((field) => ({
            label: field.title,
            description: field.invalidOverrideIssue ?? [
              `当前生效：${effectiveFieldDisplay(field)}（${field.effectiveSourceLabel}）`,
              ...pendingFieldTargets(field).map(({ scope: draftScope, value }) =>
                `待保存到${draftScope === 'project' ? '当前项目' : '个人默认'}：${value}`),
              field.description,
            ].filter((value): value is string => Boolean(value)).join(' · '),
            meta: (() => {
              const targets = pendingFieldTargets(field);
              if (targets.length === 0) {
                return `${effectiveFieldDisplay(field)} · ${field.effectiveSourceLabel}`;
              }
              if (targets.length === 1) {
                const target = targets[0]!;
                return `${target.value} · 拟保存：${target.scope === 'project' ? '当前项目' : '个人默认'}`;
              }
              return targets.map((target) =>
                `${target.scope === 'project' ? '当前项目' : '个人默认'}：${target.value}`).join(' · ');
            })(),
            configKey: field.key,
            run: () => go((['project', 'user'] as const).some((draftScope) =>
              configLayerPages[draftScope]?.groups.flatMap((group) => group.fields)
                .some((candidate) => candidate.key === field.key && candidate.configured)) ? {
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
                  ...fieldEditorMode(field),
                }),
          }));
      const operationActions: ActionItem[] = [
        ...(configDraftIssues.length > 0 ? [{
          label: '放弃无法保存的修改',
          description: `${configDraftIssues.length} 项未保存修改已不再适用于当前插件设置；放弃后不会修改已保存设置。`,
          status: 'warning' as const,
          run: discardInvalidConfigDraftChanges,
        }] : []),
        ...(['project', 'user'] as const).flatMap((resetScope) => {
          const page = configLayerPages[resetScope];
          if (!page || page.storedCount === 0) return [];
          return [{
            label: resetScope === 'user' ? '清空个人默认' : '清空当前项目设置',
            description: `删除${resetScope === 'user' ? '个人默认' : '当前项目'}中的全部值并恢复继承；其他设置层保持不变`,
            status: 'error' as const,
            run: () => beginReview({
              kind: 'configReset', pluginId: plugin.pluginId, scope: resetScope,
              changes: page.groups.flatMap((group) => group.fields).filter((field) => field.configured).map((field) => ({
                key: field.key,
                title: field.title,
                before: field.displayValue,
                after: `恢复继承（${field.fallbackDisplayValue ?? '未设置'} · ${field.fallbackSourceLabel ?? '未设置'}）`,
                ...(field.fallbackObjectChanges?.length
                  ? { children: field.fallbackObjectChanges }
                  : {}),
              })),
            }),
          }];
        }),
      ];
      const configSaveAction: ActionItem = {
        actionId: 'config-save-summary',
        label: configDraftCount > 0 ? `保存设置（${configDraftCount}）` : '保存设置',
        description: '确认全部设置层的变化，再选择只保存或保存并应用',
        status: configDraftCount > 0 ? 'success' : 'muted',
        disabled: configDraftCount === 0 ? '没有待保存设置'
          : configDraftIssues.length > 0 ? '请先放弃失效草稿' : undefined,
        run: () => {
          setFocus(0);
          setScrollOffset(0);
          go({ name: 'configSave', pluginId: route.pluginId, layer: { scope: 'effective' } });
        },
      };
      const configGroupAction: ActionItem = {
        actionId: 'config-select-group',
        label: '选择分组',
        description: '查看全部设置分组和快速方案',
        disabled: visibleConfigTabs.length === 0 ? '没有可用设置分组' : undefined,
        run: () => {
          const current = Math.max(0, visibleConfigTabs.findIndex((tab) => tab.id === activeTab?.id));
          setConfigGroupChoiceFocus(current);
          setConfigGroupChooserOpen(true);
          setFocusZone('content');
        },
      };
      pinnedActions = [configSaveAction, configGroupAction];
      actions = [...tabActions, ...operationActions];
      const effectiveConfigFocus = Math.min(focus, Math.max(0, actions.length - 1));
      const focusedConfigField = effectiveConfigFocus < (activeGroup?.fields.length ?? 0)
        ? activeGroup?.fields[effectiveConfigFocus]
        : undefined;
      if (!readonly) {
        const canUnsetFocused = focusedConfigField
          ? (['project', 'user'] as const).some((scope) =>
              configLayerPages[scope]?.groups.flatMap((group) => group.fields)
                .some((field) => field.key === focusedConfigField.key && configFieldCanUnset(field)))
          : false;
        help = focusZone === 'actions'
          ? '↑↓ 移动 · Enter 选择固定操作 · Tab 返回设置字段 · s 查看保存汇总 · Esc 返回'
          : canUnsetFocused
            ? '↑↓ 移动 · Enter 修改 · ←→ 分组 · Tab 保存栏 · s 查看汇总 · u 恢复继承 · Esc 返回'
            : '↑↓ 移动 · Enter 修改 · ←→ 分组 · Tab 保存栏 · s 查看汇总 · Esc 返回';
      }
      const fieldFocus = tabActions.length > 0
        ? effectiveConfigFocus < tabActions.length ? effectiveConfigFocus : Math.min(scrollOffset, tabActions.length - 1)
        : 0;
      const operationRows = operationActions.reduce((rows, action) =>
        rows + (policy.mode === 'compact' || !action.description ? 1 : 2), 0);
      const viewport = actionViewport(tabActions, false, fieldFocus, scrollOffset,
        pageActionBudget(2 + operationRows + 3 + (configDraftIssues.length > 0 ? 3 : 0)));
      const totalFields = currentConfigPage.groups.reduce((count, group) => count + group.fields.length, 0);
      const countLabel = `${totalFields} 项${currentConfigPage.presets.length > 0 ? ` · ${currentConfigPage.presets.length} 个方案` : ''}`;
      context = configDraftCount > 0 ? `${configDraftCount} 项待保存` : countLabel;
      const groupChoiceActions: ActionItem[] = visibleConfigTabs.map((tab) => ({
        label: tab.label,
        description: tab.kind === 'presets' ? `${tab.count} 个快速方案` : `${tab.count} 个设置字段`,
      }));
      const groupChoiceViewport = actionViewport(
        groupChoiceActions,
        false,
        configGroupChoiceFocus,
        0,
        Math.max(2, pageActionBudget(5)),
      );
      if (configGroupChooserOpen) {
        title = '选择设置分组';
        description = '选择后回到同一设置总览；未保存草稿保持不变。';
        help = '↑↓ 移动 · Enter 选择 · Esc 取消';
        context = `${visibleConfigTabs.length} 个入口`;
      }
      content = configGroupChooserOpen
        ? <Box flexDirection="column">
            <Text>完整名称：{visibleConfigTabs[configGroupChoiceFocus]?.label}</Text>
            <SectionCard title="全部分组和快速方案"
              meta={groupChoiceViewport.total > groupChoiceViewport.limit
                ? `${groupChoiceViewport.position}/${groupChoiceViewport.total}` : undefined}>
              <SemanticRows
                actions={groupChoiceActions}
                focus={configGroupChoiceFocus}
                kind="section"
                compact={false}
                offset={groupChoiceViewport.offset}
                limit={groupChoiceViewport.limit}
              />
            </SectionCard>
          </Box>
        : <Box flexDirection="column">
        <PinnedActionBar
          actions={pinnedActions.map((action) => ({
            id: action.actionId!,
            label: action.label,
            disabled: Boolean(action.disabled),
          }))}
          active={focusZone === 'actions'}
          focus={pinnedActionFocus}
        />
        {!readonly && configDraftIssues.length > 0 ? <Callout
          status="warning"
          title="有未保存修改无法继续使用"
          description="插件来源恢复后，设置内容或可用位置已变化。请放弃这些修改，或返回检查插件来源；系统不会自动保存。"
        /> : null}
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
                focus={focusZone === 'content' ? effectiveConfigFocus : -1}
                kind="section"
                compact={false}
                offset={viewport.offset}
                limit={viewport.limit}
              />
            </SectionCard>
          : null}
        {operationActions.length > 0
          ? <SemanticRows
              actions={actions}
              focus={focusZone === 'content' ? effectiveConfigFocus : -1}
              kind="action"
              compact={policy.mode === 'compact'}
              offset={tabActions.length}
              limit={operationActions.length}
            />
          : null}
      </Box>;
    }
  } else if (route.name === 'configSave' && plugin) {
    const draftGroups = (['project', 'user'] as const).flatMap((scope) => {
      const draft = configDrafts[scope];
      const page = configLayerPages[scope];
      return draft && page ? [{ scope, draft, changes: configChanges(page, draft) }] : [];
    });
    const changes = draftGroups.flatMap((group) => group.changes.map((change) => ({
      ...change,
      title: `${scopeLabel(group.scope)} · ${change.title}`,
    })));
    if (route.view === 'changes') {
      const lines = changeDetailLines(changes, size.columns - 4);
      const pageRows = Math.max(1, Math.min(
        responsiveBudget(5, 10),
        pageActionBudget(5),
      ));
      const detailOffset = Math.min(batchTargetOffset, Math.max(0, lines.length - 1));
      const visibleLines = lines.slice(detailOffset, detailOffset + pageRows);
      referenceDetailPagination = { total: lines.length, pageRows };
      breadcrumb = `${plugin.displayName} / 设置 / 完整变化`;
      context = `${Math.min(detailOffset + 1, lines.length)}–${Math.min(detailOffset + visibleLines.length, lines.length)} / ${lines.length}`;
      title = '完整设置变化';
      description = '逐项显示修改前和修改后的完整值。';
      help = 'p/n 或 PgUp/PgDn 阅读 · ↑↓ 移动 · Enter 选择 · Esc 返回保存汇总';
      actions = [
        ...paginationActions({
          offset: detailOffset,
          total: lines.length,
          pageRows,
          move: (direction) => moveBatchTargetPage(lines.length, pageRows, direction),
        }),
        { label: '返回保存汇总', run: back },
      ];
      content = <Box flexDirection="column">
        {detailOffset > 0 ? <StaticRow title={`↑ 前面还有 ${detailOffset} 行`} status="muted" compact /> : null}
        {visibleLines.map((line, index) => <StaticRow key={`${detailOffset + index}:${line}`} title={line} compact />)}
        {detailOffset + visibleLines.length < lines.length
          ? <StaticRow title={`↓ 后面还有 ${lines.length - detailOffset - visibleLines.length} 行`} status="muted" compact /> : null}
        <SemanticRows actions={actions} focus={focus} kind="action" compact />
      </Box>;
    } else {
    const visibleChanges = changes.slice(0, policy.mode === 'compact' ? 0 : 1);
    breadcrumb = `${plugin.displayName} / 设置 / 保存汇总`;
    context = `${changes.length} 项未保存`;
    title = `保存 ${changes.length} 项设置修改？`;
    description = `将按当前项目、个人默认的顺序保存 ${draftGroups.length} 个设置层。每层独立提交。`;
    actions = [
      {
        label: '保存并生效',
        description: '保存全部草稿，并重新应用实际使用这些设置的目标',
        status: 'success',
        run: () => beginConfigSave(true),
      },
      {
        label: '只保存，稍后应用',
        description: '保存全部设置层，不重新应用安装目标',
        run: () => beginConfigSave(false),
      },
      { label: '返回修改', run: back },
    ];
    actions.splice(Math.max(0, actions.length - 1), 0, {
      label: '阅读完整设置变化',
      description: '分页查看每项修改前和修改后的完整值',
      run: () => {
        setBatchTargetOffset(0);
        go({ ...route, view: 'changes' });
      },
    });
    const configSaveStaticRows = 6 + visibleChanges.length * 2 + draftGroups.length;
    const configSaveActionViewport = actionViewport(actions, policy.mode === 'compact', focus,
      scrollOffset, pageActionBudget(configSaveStaticRows));
    const changeSectionTitle = visibleChanges.length < changes.length
      ? `设置变更 · 显示 ${visibleChanges.length}/${changes.length}（另 ${changes.length - visibleChanges.length} 项）`
      : '设置变更';
    content = <Box flexDirection="column">{visibleChanges.length > 0 ? <SectionCard title={changeSectionTitle} compact={policy.mode === 'compact'}>
      {visibleChanges.map((change) => <ReviewChangeRow
        key={`${change.title}:${change.key}`}
        title={`~ ${change.title}`}
        value={`${change.before} → ${change.after}`}
        compact
      />)}
    </SectionCard> : null}<SectionCard title="保存目标" compact={policy.mode === 'compact'}>
      {draftGroups.map((group) => <StaticRow key={group.scope}
        title={scopeLabel(group.scope)} meta={`${group.changes.length} 项修改`} compact />)}
      <StaticRow title="每层独立提交；失败层保留草稿" status="warning" compact />
    </SectionCard><SemanticRows actions={actions} focus={focus} kind="action" compact={policy.mode === 'compact'}
      offset={configSaveActionViewport.offset} limit={configSaveActionViewport.limit} /></Box>;
    }
  } else if (route.name === 'configFieldAction' && plugin && activeField) {
    const layer = configLayerLabel(route.layer);
    breadcrumb = `${plugin.displayName} / 设置 / ${layer} / ${activeField.title}`;
    title = activeField.title;
    description = `这个字段在${layer}中已经有值。`;
    help = '↑↓ 移动 · Enter 选择 · Esc 返回';
    const targetFields = (['project', 'user'] as const).flatMap((scope) =>
      configLayerPages[scope]?.groups.flatMap((group) => group.fields)
        .filter((field) => field.key === activeField.key).map((field) => ({ scope, field })) ?? []);
    const canSet = targetFields.some(({ field }) => configFieldCanSet(field));
    const canUnset = targetFields.some(({ field }) => configFieldCanUnset(field));
    actions = [
      ...(canSet ? [{
        label: '修改值',
        run: () => go({
          name: 'configFieldEditor',
          pluginId: plugin.pluginId,
          layer: route.layer,
          fieldKey: activeField.key,
          editor: fieldEditor(activeField),
          ...fieldEditorMode(activeField),
        }),
      }] : []),
      ...(canUnset ? [{
        label: '恢复继承',
        description: '选择要删除覆盖值的位置',
        status: 'error' as const,
        run: () => removeDraft(activeField.key),
      }] : []),
    ];
    content = <Box flexDirection="column"><SectionCard>
      {activeField.invalidOverrideIssue
        ? <StaticRow title="当前覆盖无效" meta={activeField.invalidOverrideIssue} status="warning" />
        : null}
      {!canSet && canUnset
        ? <StaticRow title="本项目旧值不再使用" meta="当前继承个人或插件默认；删除旧值后保持继承" status="warning" />
        : null}
      <StaticRow title={`${layer}中的值`} meta={currentFieldDisplay(activeField)} />
      <StaticRow title="当前实际生效" meta={`${effectiveFieldDisplay(activeField)} · 来自${activeField.effectiveSourceLabel}`} />
      {!activeField.invalidOverrideIssue || activeField.invalidOverrideOwnedByLayer
        ? <StaticRow title="删除后将恢复" meta={`${activeField.fallbackDisplayValue ?? '未设置'} · 来自${activeField.fallbackSourceLabel ?? '未设置'}`} />
        : null}
    </SectionCard><SemanticRows actions={actions} focus={focus} kind="action" compact={policy.mode === 'compact'} /></Box>;
  } else if (route.name === 'configFieldEditor' && plugin && activeField) {
    breadcrumb = `${plugin.displayName} / 设置 / ${activeField.title}`;
    const showChoices = (activeField.choices?.length ?? 0) > 0 && route.mode !== 'custom';
    if (showChoices) {
      title = `选择${activeField.title}`;
      description = activeField.type !== 'boolean' && activeField.allowCustom
        ? '先选择插件提供的方案，也可以继续自定义。'
        : '此字段只允许使用插件提供的方案。';
      help = '↑↓ 移动 · Enter 使用 · Esc 取消';
      const current = activeCandidateMutation?.kind === 'set'
        ? activeCandidateMutation.value
        : draftUpdates[activeField.key] ?? activeField.draftValue ?? activeField.value;
      const booleanCustomValues = activeField.type === 'boolean' && activeField.allowCustom
        ? [true, false].filter((value) =>
            !activeField.choices?.some((preset) => preset.value === value))
        : [];
      actions = [
        ...(activeField.choices ?? []).map((preset) => ({
          label: `${preset.title}${preset.recommended ? '（推荐）' : ''}`,
          description: preset.description,
          selected: !activeField.sensitive
            && !configObjectHasSensitiveChild(activeField.definition)
            && configValuesEqual(current, preset.value),
          run: () => updateDraft(activeField.key, preset.value),
        })),
        ...booleanCustomValues.map((value) => ({
          label: value ? '开启' : '关闭',
          selected: !activeField.sensitive && current === value,
          run: () => updateDraft(activeField.key, value),
        })),
        ...(activeField.allowCustom && activeField.type !== 'boolean' ? [{
          label: '自定义',
          description: activeField.type === 'object' ? '编辑固定属性和动态键值' : '输入自定义值',
          run: () => {
            props.controller.replace({ ...route, mode: 'custom' });
            setFocus(0);
            setScrollOffset(0);
          },
        }] : []),
      ];
      content = <SemanticRows actions={actions} focus={focus} kind="choice" compact={policy.mode === 'compact'} />;
    } else if (route.editor === 'boolean') {
      title = `${activeField.title}？`;
      description = activeField.description ?? '选择开启或关闭。';
      help = '↑↓ 移动 · Enter 使用 · Esc 取消';
      const current = activeCandidateMutation?.kind === 'set'
        ? activeCandidateMutation.value
        : draftUpdates[activeField.key] ?? activeField.value;
      actions = [{ label: '开启', selected: !activeField.sensitive && current === true, run: () => updateDraft(activeField.key, true) }, { label: '关闭', selected: !activeField.sensitive && current === false, run: () => updateDraft(activeField.key, false) }];
      content = <SemanticRows actions={actions} focus={focus} kind="choice" compact={policy.mode === 'compact'} />;
    } else if (route.editor === 'object' && activeField.definition.type === 'object' && activeObjectDraft) {
      const objectDefinition = activeField.definition;
      title = `编辑${activeField.title}`;
      description = activeField.configured
        ? '保存时会提交这个顶层字段的完整对象。'
        : '草稿来自当前完整有效对象；保存后会在此层写入完整对象并覆盖继承对象。';
      if (objectError) description = objectError;
      help = '↑↓ 移动 · Enter 编辑 · Esc 取消';
      const fixedEntries = Object.entries(objectDefinition.properties ?? {});
      const fixedKeys = new Set(fixedEntries.map(([property]) => property));
      const dynamicKeys = Object.keys(activeObjectDraft)
        .filter((property) => !fixedKeys.has(property))
        .sort((left, right) => left.localeCompare(right, 'en'));
      const propertySummary = (
        property: string,
        definition: PluginConfigObjectPropertyField | PluginConfigAdditionalPropertiesField,
      ): string => {
        if (!Object.hasOwn(activeObjectDraft, property)) {
          return 'required' in definition && definition.required ? '必填 · 未设置' : '未设置';
        }
        if (activeField.sensitive || definition.sensitive) return '已设置';
        const value = activeObjectDraft[property]!;
        const preset = definition.choices?.presets.find((choice) => choice.value === value);
        if (preset) return preset.title;
        if (typeof value === 'boolean') return value ? '开启' : '关闭';
        return String(value);
      };
      const propertyActions: ActionItem[] = [
        ...fixedEntries.map(([property, definition]) => ({
          label: definition.title ?? property,
          description: definition.description,
          meta: propertySummary(property, definition),
          run: () => openObjectProperty(property, false),
        })),
        ...dynamicKeys.map((property) => ({
          label: property,
          meta: propertySummary(
            property,
            objectDefinition.additionalProperties as PluginConfigAdditionalPropertiesField,
          ),
          run: () => openObjectProperty(property, true),
        })),
      ];
      const objectOperationActions: ActionItem[] = [
        ...(objectDefinition.additionalProperties !== false ? [{
          label: '＋ 添加键值',
          run: () => go({
            name: 'configObjectPropertyEditor',
            pluginId: plugin.pluginId,
            layer: route.layer,
            fieldKey: activeField.key,
            dynamic: true,
            stage: 'key',
          }),
        }] : []),
        {
          label: '使用此完整对象',
          description: `${Object.keys(activeObjectDraft).length} 个属性将作为单个顶层值保存`,
          run: commitObjectDraft,
        },
      ];
      actions = [...propertyActions, ...objectOperationActions];
      const effectiveObjectFocus = Math.min(focus, Math.max(0, actions.length - 1));
      const propertyFocus = propertyActions.length > 0
        ? effectiveObjectFocus < propertyActions.length
          ? effectiveObjectFocus
          : Math.min(scrollOffset, propertyActions.length - 1)
        : 0;
      const objectViewport = actionViewport(
        propertyActions,
        policy.mode === 'compact',
        propertyFocus,
        scrollOffset,
        pageActionBudget(3 + objectOperationActions.length),
      );
      content = <Box flexDirection="column">
        {propertyActions.length > 0 ? <SectionCard title="对象属性">
          <SemanticRows
            actions={propertyActions}
            focus={effectiveObjectFocus}
            kind="section"
            compact={policy.mode === 'compact'}
            offset={objectViewport.offset}
            limit={objectViewport.limit}
          />
        </SectionCard> : null}
        <SemanticRows
          actions={actions}
          focus={effectiveObjectFocus}
          kind="action"
          compact={policy.mode === 'compact'}
          offset={propertyActions.length}
          limit={objectOperationActions.length}
        />
      </Box>;
    } else {
      title = activeField.sensitive ? '输入敏感值' : `输入${activeField.title}`;
      help = '输入 · Enter 使用 · Ctrl-U 清空输入 · Esc 取消';
      description = route.editor === 'number'
        ? `允许范围：${activeField.min ?? '不限'}–${activeField.max ?? '不限'}${activeField.unit ? ` ${activeField.unit}` : ''}。`
        : activeField.sensitive ? '当前值不会回显；留空不会自动删除旧值。' : activeField.description ?? '';
      content = <InputCard focused title={<InputDisplay value={inputValue} sensitive={activeField.sensitive} placeholder={activeField.placeholder} columns={Math.max(8, size.columns - 8)} />} description={inputError ?? (activeField.sensitive ? '输入已隐藏。' : activeField.placeholder ?? '按 Enter 使用输入值。')} status={inputError ? 'error' : undefined} />;
    }
  } else if (route.name === 'configObjectPropertyEditor' && plugin
    && activeField?.definition.type === 'object' && activeObjectDraft) {
    const property = route.propertyKey;
    const definition = activePropertyDefinition;
    const propertyTitle = definition && property ? definition.title ?? property : '动态键';
    breadcrumb = `${plugin.displayName} / 设置 / ${activeField.title} / ${propertyTitle}`;
    if (route.stage === 'key') {
      title = '输入新键名';
      description = inputError ?? '键名和属性数量会按插件规则检查。';
      help = '输入 · Enter 继续 · Ctrl-U 清空输入 · Esc 取消';
      content = <InputCard focused title={<InputDisplay value={inputValue} columns={Math.max(8, size.columns - 8)} />} description={description} status={inputError ? 'error' : undefined} />;
    } else if (property !== undefined && definition && route.stage === 'action') {
      title = propertyTitle;
      description = '这个属性已在完整对象草稿中设置。';
      help = '↑↓ 移动 · Enter 选择 · Esc 返回';
      actions = [
        {
          label: '修改值',
          run: () => {
            props.controller.replace({
              ...route,
              stage: objectPropertyStage(definition),
            });
            setFocus(0);
          },
        },
        {
          label: route.dynamic ? '删除动态键' : '删除属性',
          status: 'error',
          run: () => {
            const next = { ...activeObjectDraft };
            delete next[property];
            updateObjectDraft(next);
            back();
          },
        },
      ];
      content = <SemanticRows actions={actions} focus={focus} kind="action" compact={policy.mode === 'compact'} />;
    } else if (property !== undefined && definition && route.stage === 'choices') {
      title = `选择${propertyTitle}`;
      description = definition.type !== 'boolean' && definition.choices?.allowCustom
        ? '先选择插件提供的方案，也可以继续自定义。'
        : '只显示此属性允许的选择。';
      help = '↑↓ 移动 · Enter 使用 · Esc 取消';
      const current = activeObjectDraft[property];
      actions = definition.type === 'boolean'
        ? definition.choices
          ? [
              ...definition.choices.presets.map((preset) => ({
                label: `${preset.title}${preset.recommended ? '（推荐）' : ''}`,
                description: preset.description,
                selected: !activePropertySensitive && current === preset.value,
                run: () => { if (updateObjectProperty(property, preset.value)) back(); },
              })),
              ...(definition.choices.allowCustom
                ? [true, false]
                  .filter((value) => !definition.choices!.presets.some((preset) => preset.value === value))
                  .map((value) => ({
                    label: value ? '开启' : '关闭',
                    selected: !activePropertySensitive && current === value,
                    run: () => { if (updateObjectProperty(property, value)) back(); },
                  }))
                : []),
            ]
          : [true, false].map((value) => ({
              label: value ? '开启' : '关闭',
              selected: !activePropertySensitive && current === value,
              run: () => { if (updateObjectProperty(property, value)) back(); },
            }))
        : [
            ...(definition.choices?.presets ?? []).map((preset) => ({
              label: `${preset.title}${preset.recommended ? '（推荐）' : ''}`,
              description: preset.description,
              selected: !activePropertySensitive && current === preset.value,
              run: () => { if (updateObjectProperty(property, preset.value)) back(); },
            })),
            ...(definition.choices?.allowCustom ? [{
              label: '自定义',
              run: () => {
                props.controller.replace({ ...route, stage: 'custom' });
                setFocus(0);
              },
            }] : []),
          ];
      content = <SemanticRows actions={actions} focus={focus} kind="choice" compact={policy.mode === 'compact'} />;
    } else if (property !== undefined && definition) {
      title = activePropertySensitive ? '输入敏感值' : `输入${propertyTitle}`;
      description = inputError ?? (activePropertySensitive ? '输入已隐藏。' : definition.description ?? '按 Enter 使用输入值。');
      help = '输入 · Enter 使用 · Ctrl-U 清空输入 · Esc 取消';
      content = <InputCard focused title={<InputDisplay value={inputValue} sensitive={activePropertySensitive} columns={Math.max(8, size.columns - 8)} />} description={description} status={inputError ? 'error' : undefined} />;
    }
  } else if (route.name === 'configUnavailable') {
    const unavailablePluginName = plugin?.displayName ?? route.pluginId.split('/').at(-1) ?? route.pluginId;
    const unavailableSourceId = plugin?.sourceId ?? route.pluginId.split('/')[0] ?? '当前来源';
    breadcrumb = `${unavailablePluginName} / 设置`;
    context = '暂时不可编辑';
    const diagnostic = configUnavailableDiagnostic(route);
    const invalidLayer = (route.invalidStores?.length ?? 0) > 0;
    const canRecoverSource = configUnavailableCanRecoverSource(route);
    title = diagnostic.title;
    description = '';
    const resetScopes = route.invalidStores?.map(({ scope }) => scope)
      ?? route.storedScopes
      ?? (route.layer ? [route.layer.scope] : []);
    actions = [
      ...resetScopes.flatMap((scope) => {
        const availability = configResetAvailability[scope];
        return availability?.exists && availability.resettable !== false
          ? [{
              label: `重置${scope === 'user' ? '个人默认' : '当前项目'}设置层`,
              description: '删除整个目标层；不创建备份',
              status: 'error' as const,
              run: () => beginReview({
                kind: 'configReset',
                pluginId: route.pluginId,
                scope,
                ...(availability.state === 'invalid' ? { expectedStoreState: 'invalid' as const } : {}),
              }),
            }]
          : [];
      }),
      ...(!invalidLayer && canRecoverSource ? [
        {
          label: '修复插件来源',
          description: `检查并恢复 ${unavailableSourceId}；完成后返回当前设置位置。`,
          run: () => props.controller.beginConfigSourceRecovery(unavailableSourceId),
        },
      ] : []),
      { label: showTechnical ? '返回问题摘要' : '技术详情', description: '查看脱敏错误代码和阶段', run: () => toggleTechnical() },
      { label: '返回', run: back },
    ];
    const unsupportedScopes = resetScopes.filter((scope) =>
      configResetAvailability[scope]?.resettable === false);
    const unsupportedRows = unsupportedScopes.map((scope) => <StaticRow
      key={`unsupported-reset:${scope}`}
      title={`${scope === 'user' ? '个人默认' : '当前项目'}设置层不能自动重置：特殊节点，请手动移动`}
      status="warning"
      compact
    />);
    content = invalidLayer
      ? <Box flexDirection="column">
          <SectionCard title="不可读取的设置层">
            {(route.invalidStores ?? []).map((store) => <StaticRow
              key={store.scope}
              title={store.scope === 'user' ? '个人默认设置' : '当前项目设置'}
              meta="需要重置或手动移开"
              status="warning"
              compact
            />)}
          </SectionCard>
          {showTechnical ? <TechnicalDetails>
            {(route.invalidStores ?? []).flatMap((store) => [
              <StaticRow key={store.scope} title={scopeLabel(store.scope)} meta={store.code} compact />,
              <StaticRow key={`${store.scope}:path`} title="path summary" meta={store.pathSummary} compact />,
            ])}
            <StaticRow title="stage" meta={safeDiagnosticCode(route.diagnosticStage, 'read-config')} compact />
          </TechnicalDetails> : null}
          {unsupportedRows}
          <SemanticRows actions={actions} focus={focus} kind="action" compact />
        </Box>
      : <Box flexDirection="column"><DiagnosticSummary diagnostic={diagnostic} technical={showTechnical} compact={policy.mode === 'compact'} />{unsupportedRows}<SemanticRows actions={actions} focus={focus} kind="action" compact={policy.mode === 'compact'} /></Box>;
  } else if (route.name === 'sourceList') {
    breadcrumb = '插件来源';
    title = '插件来源';
    description = '单个来源失败不会阻止其他来源继续工作。';
    context = `${props.controller.listSources().length} 个来源`;
    help = '↑↓ 移动 · Enter 打开 · Esc 返回';
    actions = props.controller.listSources().map((source) => {
        const overview = props.controller.getSourceOverview(source.id);
        const generation = props.controller.getCatalogGeneration(source.id);
        const freshness = props.controller.getCatalogFreshness(source.id);
        const configured = props.controller.getConfiguredSource(source.id);
        const health = generation?.state !== undefined && generation.state !== 'ready'
          ? 'unavailable' as const
          : overview.health?.state ?? source.state;
        const presentation = catalogSourceListPresentation({
          freshness,
          activeVersion: generation?.active?.catalogVersion,
          health,
          primary: source.primary,
        });
        const transport = overview.detail?.type === 'path' ? '本地'
          : configured?.type === 'git'
            && (configured.url.startsWith('git@') || configured.url.startsWith('ssh://'))
            ? 'SSH' : 'HTTPS';
        const version = `${generation?.active?.catalogVersion ?? '未启用'}${freshness?.candidate?.catalogVersion
          ? `→${freshness.candidate.catalogVersion}` : ''}`;
        const available = generation?.state === 'ready' || health === 'ready';
        const unavailable = health === 'unavailable' || health === 'error' || health === 'recovery';
        return {
          label: source.id,
          description: sourceLocationSummary(overview.detail?.type ?? 'git', overview.detail?.locationSummary),
          meta: `当前 ${version} · ${source.count === undefined ? '插件数未知' : `${source.count} 个插件`}`,
          tags: <Box>
            <Text color={tuiTheme.colors.muted}>[{source.primary ? '主来源' : transport}] </Text>
            <StatusBadge items={[{ key: 'health', label: available ? '可用' : unavailable ? '不可用' : '未确认',
              symbol: available ? '✓' : unavailable ? '!' : '?', status: available ? 'success' : unavailable ? 'warning' : 'muted' }]} />
            {freshness && freshness.state !== 'current' && freshness.state !== 'fixed'
              ? <Text color={tuiTheme.colors.accent}> [{freshness.state === 'updateAvailable' ? '↑ ' : ''}{presentation.label}]</Text>
              : null}
          </Box>,
          status: presentation.status,
          run: () => go({ name: 'sourceDetail', sourceId: source.id }),
        };
      });
    pinnedActions = [
      { label: '＋ 添加来源', description: 'Git 仓库或本地目录', run: beginAddSource },
      {
        label: '检查全部来源',
        description: '并行检查各来源；必要时完整验证；结果不会自动启用待检查版本',
        run: () => props.controller.recheckAllCatalogSources(),
      },
      { label: 'Catalog 本地存储', description: '检查占用和预览安全清理', run: () => go({ name: 'catalogStoreOverview' }) },
    ];
    help = focusZone === 'actions'
      ? '←→ 移动固定操作 · Enter 选择 · Tab 返回来源卡片 · Esc 返回'
      : '↑↓ 移动 · Enter 打开 · Tab 固定操作 · r/c 检查全部 · Esc 返回';
    const viewport = rowViewport({
      rowHeights: actions.map((action) => objectCardRowLayout({
        description: action.description ?? '', meta: action.meta, width: size.columns - 2, hasTags: true,
      }).height),
      focus, requestedOffset: scrollOffset, rowBudget: pageActionBudget(1),
    });
    content = <Box flexDirection="column">
      <PinnedActionBar
        actions={pinnedActions.map((action, index) => ({
          id: action.actionId ?? `${action.label}:${index}`,
          label: action.label,
          disabled: Boolean(action.disabled),
        }))}
        active={focusZone === 'actions'}
        focus={pinnedActionFocus}
        visibleCount={policy.mode === 'compact' ? 2 : 3}
      />
      <ContentViewport>
        <SemanticRows actions={actions} focus={focusZone === 'content' ? focus : -1} kind="section" cards columns={size.columns - 2}
          compact={policy.mode === 'compact'} offset={viewport.offset} limit={viewport.limit} />
      </ContentViewport>
    </Box>;
  } else if (route.name === 'catalogStoreOverview') {
    breadcrumb = '插件来源 / 本地存储';
    title = 'Catalog 本地存储';
    description = '检查可重建的本地目录版本，并只清理已确认的安全项目。';
    help = '↑↓ 移动 · Enter 选择 · Esc 返回';
    const totals = catalogStoreStatus?.totals;
    const sizeText = totals?.reclaimableBytes === null
      ? '大小未知'
      : totals ? `${totals.reclaimableBytes} bytes` : '正在检查';
    actions = [
      {
        actionId: 'catalog-store-prune-preview',
        label: '预览安全清理',
        description: totals ? `${totals.reclaimableEntries} 个可回收项 · ${sizeText}` : '先读取当前存储状态',
        ...(totals && totals.reclaimableEntries > 0
          ? { run: () => beginReview({ kind: 'catalogStorePrune' }) }
          : { disabled: catalogStoreError ? '当前无法读取本地存储' : totals ? '没有可回收项' : '正在检查' }),
      },
      { actionId: 'catalog-store-rules', label: '查看保留规则', description: '了解哪些目录会保留，以及旧版本何时可以清理', run: () => go({ name: 'catalogStoreRules' }) },
      { actionId: 'catalog-store-refresh', label: '重新检查', description: '重新读取当前本地存储', run: () => setCatalogStoreRefresh((value) => value + 1) },
      { actionId: 'catalog-store-back', label: '返回来源列表', run: back },
    ];
    content = <Box flexDirection="column">
      {catalogStoreError
        ? <Callout status="warning" title="本地存储检查失败" description="未执行删除。请检查 Catalog 配置和本地存储后重试。" />
        : totals
          ? <StatusCard title="存储概览" status={catalogStoreStatus?.ok ? 'success' : 'warning'}>
              <StaticRow title="全部项目" meta={`${totals.entries}`} compact />
              <StaticRow title="可回收项目" meta={`${totals.reclaimableEntries}`} compact />
              <StaticRow title="预计可回收大小" meta={sizeText} compact />
            </StatusCard>
          : <StatusCard title="正在检查本地存储" status="info"><StaticRow title="读取当前项目和保留原因" compact /></StatusCard>}
      <SemanticRows actions={actions} focus={focus} kind="action" compact={policy.mode === 'compact'} />
    </Box>;
  } else if (route.name === 'catalogStoreRules') {
    breadcrumb = '插件来源 / 本地存储 / 保留规则';
    title = '安全清理规则';
    description = policy.mode === 'compact'
      ? '' : '清理前会再次检查每个项目，只删除能够确认安全的旧内容。';
    actions = [
      { actionId: 'catalog-store-rules-technical', label: showTechnical ? '隐藏技术详情' : '技术详情', run: () => toggleTechnical() },
      { actionId: 'catalog-store-rules-back', label: '返回存储概览', run: back },
    ];
    content = <Box flexDirection="column">
      {!showTechnical ? <>
      <SectionCard title="始终保留 · 当前使用的目录不会删除">
        <StaticRow title="不属于 AW、无法确认安全或仍在使用的内容会保留" status="muted" compact />
      </SectionCard>
      <SectionCard title="满足时间和完整验证后可回收">
        <StaticRow title="旧版本满足保留期限后才清理" compact />
        <StaticRow title="未完成的下载或替换内容至少保留 24 小时" compact />
        <StaticRow title="隔离内容至少保留 24 小时" compact />
        <StaticRow title="对应正式版本完整可用后才清理" compact />
      </SectionCard>
      </> : null}
      {showTechnical ? <TechnicalDetails title="清理判定证据">
        <StaticRow title="锁" meta="AW_HOME 写锁内重新检查" compact />
        <StaticRow title="正式目录版本" meta="非 Active 项保留 30 天" compact />
        <StaticRow title="staging、replacement、delete claim" meta="保留 24 小时" compact />
        <StaticRow title="quarantine" meta="保留 24 小时；对应正式目录版本必须完整健康" compact />
        <StaticRow title="保留节点" meta="foreign、符号链接、unsafe、损坏或未知项目" compact />
      </TechnicalDetails> : null}
      <SemanticRows actions={actions} focus={focus} kind="action" compact={policy.mode === 'compact'} />
    </Box>;
  } else if (route.name === 'sourceDetail') {
    const overview = props.controller.getSourceOverview(route.sourceId);
    const detail = overview.detail;
    const generation = props.controller.getCatalogGeneration(route.sourceId);
    const freshness = props.controller.getCatalogFreshness(route.sourceId);
    const activeVersion = generation?.active?.catalogVersion;
    const candidateVersion = freshness?.candidate?.catalogVersion;
    const generationState = generation?.state ?? (generation?.active ? 'ready' : 'unavailable');
    const combinedRepairAndMismatch = generationState === 'repairRequired'
      && generation?.configMismatch === true;
    const logicalIdentityChanged = generation?.errorCode === 'catalogLogicalIdentityChanged';
    const activationBlocked = props.controller.catalogSourceRecoveryBlockReason();
    breadcrumb = `插件来源 / ${route.sourceId}`;
    context = detail?.type === 'path' ? '本地目录' : 'Git';
    title = route.sourceId;
    description = generationState === 'incompatible'
      ? `当前目录版本与 AW 不兼容；缺少 ${generation?.compatibility?.state === 'unsupported' ? generation.compatibility.missingCapabilities.length : 0} 项功能支持。`
      : freshness?.state === 'incompatible'
      ? generationState === 'repairRequired'
        ? `待检查版本需要升级 AW 或修改来源后才能使用；损坏的当前启用版本仍可按旧版本精确修复。`
        : activeVersion && generationState === 'ready'
        ? `当前 AW 缺少 ${freshness.missingCapabilities?.length ?? 0} 项待检查版本所需功能；当前目录版本 ${activeVersion} 仍可浏览和使用。`
        : `当前 AW 缺少 ${freshness.missingCapabilities?.length ?? 0} 项待检查版本所需功能；这个来源没有可用目录版本。`
      : freshness?.state === 'checkFailed' && activeVersion && generationState === 'ready'
      ? `更新检查失败，但当前目录版本 ${activeVersion} 仍可浏览和使用。`
      : freshness?.state === 'updateAvailable' && generationState === 'ready'
        ? `当前使用 ${activeVersion ?? '未启用'}；待检查版本 ${candidateVersion ?? '未知'} 可更新。`
        : freshness?.state === 'localChangesAvailable' && generationState === 'ready'
          ? '本地插件目录内容已变化；确认前仍使用当前启用版本。'
          : activeVersion && generationState === 'ready' ? `当前使用目录版本 ${activeVersion}。`
      : generationState === 'stateInvalid' ? '目录版本状态无效。确认恢复后可以重新启用这个来源。'
        : generationState === 'repairRequired' ? combinedRepairAndMismatch
          ? '当前目录版本损坏，且来源配置已变化。验证待检查版本后可精确修复同一版本，或明确切换到新版本。'
          : '当前目录版本缺失或损坏。可在这里精确修复。'
        : generationState === 'configMismatch' ? '来源配置与当前启用版本不一致。可验证待检查版本并切换。'
          : logicalIdentityChanged ? '来源发布身份已变化。请编辑来源，或移除后重新添加。'
            : '来源没有可用的启用版本。可在这里取得并启用。';
    help = '↑↓ 移动 · Enter 选择 · Esc 返回';
    if (policy.mode === 'compact') description = '';
    const generationAction: ActionItem[] = logicalIdentityChanged ? []
      : generationState === 'incompatible' ? [{
          actionId: 'source-view-incompatible',
          label: '查看不兼容详情',
          description: '显示所需和缺少的功能支持',
          status: 'error',
          run: () => go({ name: 'sourceTechnical', sourceId: route.sourceId }),
        }]
      : generationState === 'repairRequired' ? [{
          actionId: 'source-repair',
          label: '重新下载旧版本并精确修复',
          description: '使用当前启用版本的精确提交；成功后保持此版本',
          disabled: activationBlocked ? `请先处理：${sourceOperationBlockLabel(activationBlocked)}` : undefined,
          run: () => beginReview({
            kind: 'catalogGeneration',
            action: 'repair',
            sourceId: route.sourceId,
          }),
        }, ...(freshness?.state === 'incompatible' ? [] : [{
          actionId: 'source-replace-damaged',
          label: '使用待检查版本替换损坏版本',
          description: '旧版本无法取得时使用；进入独立影响确认',
          disabled: activationBlocked ? `请先处理：${sourceOperationBlockLabel(activationBlocked)}` : undefined,
          run: () => beginReview({
            kind: 'catalogGeneration',
            action: 'replaceDamaged',
            sourceId: route.sourceId,
          }),
        }])]
      : freshness?.state === 'incompatible' && generationState !== 'ready' ? []
      : generationState !== 'ready' ? [{
          actionId: 'source-activate',
          label: generationState === 'stateInvalid' ? '恢复状态并启用'
              : generationState === 'configMismatch' ? '验证并切换' : '获取并启用',
          description: '先准备只读的待检查版本确认；确认后才切换当前版本',
          disabled: activationBlocked ? `请先处理：${sourceOperationBlockLabel(activationBlocked)}` : undefined,
          run: () => beginReview({
            kind: 'catalogGeneration',
            action: generationState === 'stateInvalid' ? 'recoverState'
              : generationState === 'configMismatch' ? 'update' : 'activate',
            sourceId: route.sourceId,
          }),
        }]
        : freshness?.state === 'updateAvailable' || freshness?.state === 'localChangesAvailable'
          ? [{
              actionId: 'source-update',
              label: freshness.state === 'localChangesAvailable'
                ? '应用本地内容变化' : `更新到 ${candidateVersion ?? '待检查版本'}`,
              description: '进入确认；确认前不会切换当前版本',
              disabled: activationBlocked ? `请先处理：${sourceOperationBlockLabel(activationBlocked)}` : undefined,
              run: () => beginReview({ kind: 'catalogGeneration', action: 'update', sourceId: route.sourceId }),
            }]
          : freshness?.state === 'versionConflict'
            || freshness?.state === 'rollbackDetected'
            || freshness?.state === 'incompatible'
            ? [{
                actionId: 'source-view-version-problem',
                label: freshness.state === 'versionConflict' ? '查看版本冲突'
                  : freshness.state === 'rollbackDetected' ? '查看回退详情' : '查看不兼容详情',
                description: '普通更新已阻止；当前启用版本保持不变',
                status: 'error',
                run: () => go({ name: 'sourceTechnical', sourceId: route.sourceId }),
              }]
            : [{
                actionId: 'source-check',
                label: freshness?.state === 'checking' ? '正在检查' : '检查来源',
                description: '检查这个来源；检测到变化或异常时完整验证',
                disabled: freshness?.state === 'checking' ? '检查正在进行' : undefined,
                run: () => props.controller.recheckCatalogSource(route.sourceId),
              }];
    const managementActions: ActionItem[] = [
      { actionId: 'source-settings', label: '来源设置', description: '下载方式、版本、自动检查和高级地址目录', run: () => openSourceEdit(route.sourceId) },
      ...(generationState === 'incompatible'
        || (freshness?.state === 'incompatible' && generationState !== 'ready') ? [] : [{
        actionId: 'source-set-primary',
        label: generationState === 'ready' ? '设为主来源' : '启用并设为主来源',
        description: generationState === 'ready' ? '只改变默认插件来源' : '先启用确认的待检查版本，再设为主来源',
        disabled: detail?.primary ? '当前已经是主来源'
          : logicalIdentityChanged ? '请编辑来源，或移除后重新添加' : undefined,
        run: () => generationState === 'ready'
          ? beginReview({ kind: 'sourceMutation', action: 'setPrimary', sourceId: route.sourceId, changes: [{ title: '主来源', before: snapshot.viewModel?.sourceTabs.find((source) => source.primary)?.id, after: route.sourceId }] })
          : beginReview({
              kind: 'catalogGeneration',
              action: generationState === 'stateInvalid' ? 'recoverState'
                : generationState === 'repairRequired' && !combinedRepairAndMismatch ? 'repair'
                : generationState === 'configMismatch' || combinedRepairAndMismatch ? 'update' : 'activate',
              sourceId: route.sourceId,
              setPrimaryAfterActivation: true,
            }),
      }]),
      { actionId: 'source-remove', label: '移除来源', description: '移除来源配置', status: 'error', disabled: props.controller.listSources().length <= 1 ? '至少保留一个来源' : detail?.primary ? '主来源不能直接移除' : undefined, run: () => beginReview({ kind: 'sourceMutation', action: 'remove', sourceId: route.sourceId, changes: [{ title: `移除来源 ${route.sourceId}` }] }) },
      { actionId: 'source-technical', label: '技术详情', description: '查看脱敏错误代码和当前版本证据', run: () => go({ name: 'sourceTechnical', sourceId: route.sourceId }) },
      ...(generationState !== 'ready'
        || freshness?.state === 'updateAvailable'
        || freshness?.state === 'localChangesAvailable'
        || freshness?.state === 'versionConflict'
        || freshness?.state === 'rollbackDetected'
        || freshness?.state === 'incompatible' ? [{
        actionId: 'source-check',
        label: freshness?.state === 'checking' ? '正在检查' : '检查来源',
        description: '检查这个来源；检测到变化或异常时完整验证',
        disabled: freshness?.state === 'checking' ? '检查正在进行' : undefined,
        run: () => props.controller.recheckCatalogSource(route.sourceId),
      }] : []),
      {
        actionId: 'source-full-validate',
        label: '完整验证',
        description: '强制重新取得并完整验证这个来源',
        disabled: freshness?.state === 'checking' ? '检查正在进行' : undefined,
        run: () => props.controller.fullValidateCatalogSource(route.sourceId),
      },
    ];
    const sourcePrimaryAction: ActionItem[] = generationAction.length === 0 ? [] : [{
      ...generationAction[0]!,
      ...(generationState === 'repairRequired' || generationState === 'stateInvalid'
        || generationState === 'unavailable'
        ? {
            label: '恢复来源',
            description: generationState === 'repairRequired'
              ? '优先取得当前版本并精确修复；不会自动切换版本'
              : '取得并验证可用目录后再启用',
            status: 'warning' as const,
          }
        : {}),
    }];
    const configuredSource = props.controller.getConfiguredSource(route.sourceId);
    const transport = detail?.type === 'path' ? '本地目录'
      : configuredSource?.type === 'git'
        && (configuredSource.url.startsWith('git@') || configuredSource.url.startsWith('ssh://'))
        ? 'SSH' : 'HTTPS';
    const versionPolicy = detail?.type === 'path' ? '当前本地内容'
      : detail?.refPolicy === 'cliChannel' ? '跟随 AW 的稳定版或预览版目录'
        : '固定版本或 Git 引用';
    const sourceCount = snapshot.viewModel?.sourceTabs.find((source) => source.id === route.sourceId)?.count;
    const checkAction: ActionItem = {
      actionId: 'source-check',
      label: freshness?.state === 'checking' ? '正在检查' : '检查来源',
      description: '检查这个来源；检测到变化或异常时完整验证；不会自动启用更新',
      disabled: freshness?.state === 'checking' ? '检查正在进行' : undefined,
      run: () => props.controller.recheckCatalogSource(route.sourceId),
    };
    actions = [
      ...sourcePrimaryAction,
      ...(sourcePrimaryAction.some((action) => action.actionId === 'source-check')
        ? [] : [checkAction]),
      {
        actionId: 'source-view-plugins',
        label: '查看此来源插件',
        description: sourceCount === undefined ? '插件数未知' : `${sourceCount} 个插件`,
        run: () => go({ name: 'pluginList', mode: 'browse', sourceId: route.sourceId }),
      },
      managementActions[0]!,
      managementActions.find((action) => action.actionId === 'source-remove')!,
      {
        actionId: 'source-more',
        label: '更多操作',
        description: '替换候选、主来源和技术详情',
        run: () => go({ name: 'sourceMore', sourceId: route.sourceId }),
      },
    ];
    const freshnessLabel = freshness?.state === 'checkFailed' && generationState !== 'ready'
      ? '检查失败' : catalogSourceFreshnessLabel(freshness);
    const sourceStateLabel = generationState === 'ready' ? '来源可用'
      : generationState === 'repairRequired' ? '来源目录损坏，当前无法使用'
        : generationState === 'incompatible' ? '当前 AW 无法使用这个目录版本'
          : generationState === 'configMismatch' ? '来源设置与当前目录不一致'
            : generationState === 'stateInvalid' ? '来源状态需要恢复'
              : '来源尚未启用';
    const sourceSummary = [
      `${transport} · ${sourceLocationSummary(detail?.type ?? 'git', detail?.locationSummary)}`,
      `当前 ${activeVersion ?? '未启用'}${candidateVersion ? ` → ${candidateVersion}` : ''} · ${sourceCount === undefined ? '插件数未知' : `${sourceCount} 个插件`}`,
      `版本策略：${versionPolicy}`,
      `检查：${freshnessLabel} · ${freshness?.checkedAt ?? '尚未检查'}`,
    ].join('\n');
    const sourceCardHeight = objectCardRowLayout({
      description: sourceSummary, width: size.columns - 2, hasTags: true,
    }).height;
    const focusedSourceDescription = actions[focus]?.disabled ?? actions[focus]?.description;
    const sourceDescriptionLines = focusedSourceDescription
      ? wrapConsoleText(focusedSourceDescription, size.columns - 2) : [];
    const sourceActionDescriptionLines = sourceDescriptionLines.length <= pageActionBudget(sourceCardHeight + 1)
      ? sourceDescriptionLines : [];
    const detailMenuViewport = actionViewport(actions, true, focus, scrollOffset,
      pageActionBudget(sourceCardHeight + sourceActionDescriptionLines.length));
    content = <Box flexDirection="column">
      <ObjectCardRow width={size.columns - 2} title={route.sourceId} description={sourceSummary}
        tags={<Box>
          {detail?.primary ? <Text color={tuiTheme.colors.accent}>[主来源] </Text> : null}
          <StatusBadge items={[{ key: 'source-state', label: sourceStateLabel,
            symbol: generationState === 'ready' ? '✓' : '!',
            status: generationState === 'ready' ? 'success' : 'warning' }]} />
        </Box>} />
      <SemanticRows actions={actions} focus={focus} kind="action" compact
        offset={detailMenuViewport.offset} limit={detailMenuViewport.limit} />
      {sourceActionDescriptionLines.map((line, index) =>
        <Text key={index} color={tuiTheme.colors.muted}>{line}</Text>)}
    </Box>;
  } else if (route.name === 'sourceMore') {
    const overview = props.controller.getSourceOverview(route.sourceId);
    const detail = overview.detail;
    const generation = props.controller.getCatalogGeneration(route.sourceId);
    const freshness = props.controller.getCatalogFreshness(route.sourceId);
    const generationState = generation?.state ?? (generation?.active ? 'ready' : 'unavailable');
    const combinedRepairAndMismatch = generationState === 'repairRequired'
      && generation?.configMismatch === true;
    const logicalIdentityChanged = generation?.errorCode === 'catalogLogicalIdentityChanged';
    const activationBlocked = props.controller.catalogSourceRecoveryBlockReason();
    const blocked = activationBlocked ? `请先处理：${sourceOperationBlockLabel(activationBlocked)}` : undefined;
    breadcrumb = `插件来源 / ${route.sourceId} / 更多处理方式`;
    title = '管理来源';
    description = '选择精确操作。每个写入动作都会进入独立确认。';
    help = '↑↓ 移动 · Enter 选择 · Esc 返回';
    actions = [
      ...(generationState === 'repairRequired' ? [{
        label: '重新下载旧版本并精确修复',
        description: '使用当前启用版本的精确提交；成功后保持此版本',
        disabled: blocked,
        run: () => beginReview({ kind: 'catalogGeneration', action: 'repair', sourceId: route.sourceId }),
      }, ...freshness?.state === 'incompatible' ? [] : [{
        label: '使用待检查版本替换损坏版本',
        description: '旧版本无法取得时使用；这会进入独立风险确认',
        disabled: blocked,
        run: () => beginReview({ kind: 'catalogGeneration', action: 'replaceDamaged', sourceId: route.sourceId }),
      }]] : []),
      ...(generationState !== 'ready' && generationState !== 'repairRequired'
        && generationState !== 'incompatible' && !logicalIdentityChanged ? [{
        label: generationState === 'stateInvalid' ? '恢复状态并启用'
          : generationState === 'configMismatch' ? '验证并切换' : '获取并启用',
        description: '先准备只读候选；确认后才切换当前目录版本',
        disabled: blocked,
        run: () => beginReview({
          kind: 'catalogGeneration',
          action: generationState === 'stateInvalid' ? 'recoverState'
            : generationState === 'configMismatch' ? 'update' : 'activate',
          sourceId: route.sourceId,
        }),
      }] : []),
      ...(generationState === 'ready'
        && (freshness?.state === 'updateAvailable' || freshness?.state === 'localChangesAvailable') ? [{
        label: freshness.state === 'localChangesAvailable' ? '应用本地内容变化'
          : `更新到 ${freshness.candidate?.catalogVersion ?? '待检查版本'}`,
        description: '确认前不会切换当前版本',
        disabled: blocked,
        run: () => beginReview({ kind: 'catalogGeneration', action: 'update', sourceId: route.sourceId }),
      }] : []),
      {
        label: generationState === 'ready' ? '设为主来源' : '启用并设为主来源',
        description: generationState === 'ready' ? '只改变默认插件来源' : '启用已验证候选后改变默认来源',
        disabled: detail?.primary ? '当前已经是主来源'
          : logicalIdentityChanged ? '请编辑来源，或移除后重新添加' : blocked,
        run: () => generationState === 'ready'
          ? beginReview({ kind: 'sourceMutation', action: 'setPrimary', sourceId: route.sourceId,
              changes: [{ title: '主来源', before: snapshot.viewModel?.sourceTabs.find((source) => source.primary)?.id, after: route.sourceId }] })
          : beginReview({
              kind: 'catalogGeneration',
              action: generationState === 'stateInvalid' ? 'recoverState'
                : generationState === 'repairRequired' && !combinedRepairAndMismatch ? 'repair'
                  : generationState === 'configMismatch' || combinedRepairAndMismatch ? 'update' : 'activate',
              sourceId: route.sourceId,
              setPrimaryAfterActivation: true,
            }),
      },
      { label: '移除来源', description: '检查当前、历史和未知引用后再确认', status: 'error',
        disabled: props.controller.listSources().length <= 1 ? '至少保留一个来源'
          : detail?.primary ? '主来源不能直接移除' : undefined,
        run: () => beginReview({ kind: 'sourceMutation', action: 'remove', sourceId: route.sourceId,
          changes: [{ title: `移除来源 ${route.sourceId}` }] }) },
      { label: freshness?.state === 'checking' ? '正在检查' : '检查来源',
        description: '检查这个来源；检测到变化或异常时完整验证；不会自动启用更新',
        disabled: freshness?.state === 'checking' ? '检查正在进行' : undefined,
        run: () => props.controller.recheckCatalogSource(route.sourceId) },
      { label: '技术详情', description: '查看脱敏错误代码和版本证据',
        run: () => go({ name: 'sourceTechnical', sourceId: route.sourceId }) },
    ];
    const viewport = actionViewport(actions, policy.mode === 'compact', focus, scrollOffset, pageActionBudget(1));
    content = <SemanticRows actions={actions} focus={focus} kind="action" compact={policy.mode === 'compact'} offset={viewport.offset} limit={viewport.limit} />;
  } else if (route.name === 'sourceTechnical') {
    const diagnostic = resolveSourceTechnicalDiagnostic(route.sourceId);
    breadcrumb = `插件来源 / ${route.sourceId} / 技术详情`;
    const lines = diagnosticDetailLines(diagnostic, size.columns - 6);
    const offset = Math.min(batchTargetOffset, Math.max(0, lines.length - sourceTechnicalPageRows));
    context = `${offset + 1}–${Math.min(lines.length, offset + sourceTechnicalPageRows)} / ${lines.length} 行`;
    title = '来源技术诊断';
    description = '';
    help = '↑↓ 选择翻页 · Enter 执行 · p/n 翻页 · Esc 返回';
    const sourceTechnicalLastOffset = Math.max(0,
      lines.length - sourceTechnicalPageRows);
    actions = [
      { label: 'p 上一页', run: () => setBatchTargetOffset((value) => Math.max(0, value - sourceTechnicalPageRows)) },
      { label: 'n 下一页', run: () => setBatchTargetOffset((value) => Math.min(sourceTechnicalLastOffset, value + sourceTechnicalPageRows)) },
      { label: '返回来源详情', run: back },
    ];
    content = <Box flexDirection="column">
      <SectionCard title="完整安全字段" compact>
        {lines.slice(offset, offset + sourceTechnicalPageRows).map((line, index) =>
          <Text key={offset + index}>{line}</Text>)}
      </SectionCard>
      <SemanticRows actions={actions} focus={focus} kind="action" compact />
    </Box>;
  } else if (route.name === 'sourceAdd' && sourceDraft?.owner === route.owner) {
    breadcrumb = sourceDraft.mode === 'add' ? '插件来源 / 添加' : `插件来源 / ${sourceDraft.sourceId} / 编辑`;
    const stepLabel = { type: '第 1 步，共 6 步', id: '第 2 步，共 6 步', location: '第 3 步，共 6 步', refPolicy: '第 4 步，共 6 步', ref: '第 5 步，共 6 步', subdir: '可选高级步骤' }[route.step];
    context = stepLabel;
    help = route.step === 'type' || route.step === 'refPolicy'
      ? '↑↓ 移动 · Enter 继续 · Esc 返回' : '输入 · Enter 继续 · Esc 返回';
    if (route.step === 'type') {
      title = '选择来源类型'; description = '来源类型创建后不能修改。';
      const selectType = (type: SourceDraft['type']): void => {
        setSourceDraft({ ...sourceDraft, type });
        setDirty(true);
        go({ name: 'sourceAdd', step: sourceDraft.sourceId ? 'location' : 'id', owner: route.owner });
      };
      actions = [
        { label: 'Git 仓库', description: '使用现有自动检查默认值；可在修改汇总前单独更改', run: () => selectType('git') },
        { label: '本地目录', description: '使用现有自动检查默认值；可在修改汇总前单独更改', run: () => selectType('path') },
      ]; content = <SemanticRows actions={actions} focus={focus} kind="choice" compact={policy.mode === 'compact'} />;
    } else if (route.step === 'refPolicy') {
      title = '选择版本来源'; description = '选择稳定版、预览版，或指定一个版本。';
      const useRefPreset = async (refPolicy: SourceDraft['refPolicy'], ref: string): Promise<void> => {
        const next = { ...sourceDraft, refPolicy, ref };
        setSourceDraft(next);
        setDirty(true);
        if (route.returnToDraft) acceptSourceFieldAndBack();
        else go({ name: 'sourceAdd', step: 'subdir', owner: route.owner });
      };
      actions = [
        { label: '自动选择', description: `跟随当前 AW 使用${snapshot.cliChannel === 'beta' ? '预览版' : '稳定版'}目录`, selected: sourceDraft.refPolicy === 'cliChannel', run: () => { const policy = catalogRefPolicyForPreset('followCli')!; return useRefPreset(policy.type, ''); } },
        { label: '稳定版', description: '使用稳定发布的插件目录', selected: sourceDraft.refPolicy === 'explicit' && sourceDraft.ref === CATALOG_LATEST_REF, run: () => { const policy = catalogRefPolicyForPreset('release')!; return useRefPreset(policy.type, policy.type === 'explicit' ? policy.ref : ''); } },
        { label: '预览版', description: '使用预览发布的插件目录', selected: sourceDraft.refPolicy === 'explicit' && sourceDraft.ref === CATALOG_BETA_REF, run: () => { const policy = catalogRefPolicyForPreset('beta')!; return useRefPreset(policy.type, policy.type === 'explicit' ? policy.ref : ''); } },
        { label: '指定版本', description: '输入分支名、标签或完整提交标识', selected: sourceDraft.refPolicy === 'explicit' && sourceDraft.ref !== CATALOG_LATEST_REF && sourceDraft.ref !== CATALOG_BETA_REF, run: () => {
          if (route.returnToDraft) props.controller.replace({ name: 'sourceAdd', step: 'ref', owner: route.owner, returnToDraft: true });
          else go({ name: 'sourceAdd', step: 'ref', owner: route.owner });
        } },
      ]; content = <Box flexDirection="column">
        <Text color={tuiTheme.colors.muted}>自动选择：当前 AW 使用{snapshot.cliChannel === 'beta' ? '预览版' : '稳定版'}目录</Text>
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
    const activeDraft = route.owner && sourceDraft?.owner === route.owner ? sourceDraft : undefined;
    const startDraftField = (step: 'location' | 'refPolicy' | 'subdir'): void => {
      let draft = activeDraft;
      if (!draft) {
        const source = props.controller.getConfiguredSource(route.sourceId);
        if (!source) return;
        const owner = `source-update:${route.sourceId}:${Date.now()}`;
        draft = sourceDraftFromSource(source, owner);
        setSourceDraft(draft);
        props.controller.replace({ name: 'sourceEdit', sourceId: route.sourceId, owner });
      }
      go({ name: 'sourceAdd', step, owner: draft.owner, returnToDraft: true });
    };
    const draft = activeDraft;
    breadcrumb = `插件来源 / ${route.sourceId} / 编辑`;
    title = draft?.mode === 'add' ? `检查新来源 ${draft.sourceId}` : `编辑 ${route.sourceId}`;
    description = '在一个草稿中修改来源设置，最后查看修改汇总。';
    const locationSummary = draft
      ? projectCatalogSourceLocation(draft.location)
      : detail?.locationSummary ?? '不可用';
    const configuredSource = props.controller.getConfiguredSource(route.sourceId);
    const currentLocation = draft?.location
      ?? (configuredSource?.type === 'git' ? configuredSource.url : undefined);
    const officialTransport = currentLocation === OFFICIAL_CATALOG_SOURCE_URL ? 'HTTPS'
      : currentLocation === OFFICIAL_CATALOG_SOURCE_SSH_URL ? 'SSH' : undefined;
    const catalogSubdir = draft ? draft.subdir : detail?.subdir;
    actions = [
      ...(route.sourceId === 'official' && officialTransport ? [{
        label: '下载方式',
        meta: officialTransport,
        description: officialTransport === 'HTTPS'
          ? '默认方式；无需预先配置 SSH 密钥'
          : '适合已配置 GitHub SSH 访问的用户',
        run: () => {
          const active = draft ?? (configuredSource
            ? sourceDraftFromSource(configuredSource, `source-update:${route.sourceId}:${Date.now()}`)
            : undefined);
          if (!active) return;
          setSourceTransportOverlay({ owner: active.owner });
          setOverlayFocus(officialTransport === 'HTTPS' ? 0 : 1);
        },
      }] : [{ label: draft?.type === 'path' || detail?.type === 'path' ? '本地目录' : 'Git 仓库地址', meta: locationSummary, run: () => startDraftField('location') }]),
      ...(draft?.type === 'git' || !draft && detail?.type === 'git' ? [
        { label: '版本引用', meta: draft ? draft.refPolicy === 'explicit' ? `固定：${draft.ref}` : '跟随 AW 版本通道' : detail?.refPolicy === 'explicit' ? `固定：${detail.explicitRef}` : '跟随 AW 版本通道', run: () => startDraftField('refPolicy') },
        { label: '高级：Catalog 子目录', meta: catalogSubdir === '' || catalogSubdir === undefined
          ? '仓库根目录' : catalogSubdir, run: () => startDraftField('subdir') },
      ] : []),
      { label: '自动检查更新', meta: (draft?.autoCheck ?? detail?.autoCheck) ? '已开启' : '已关闭', selected: draft?.autoCheck ?? detail?.autoCheck, run: () => {
        if (!draft) {
          const source = props.controller.getConfiguredSource(route.sourceId);
          if (!source) return;
          const owner = `source-update:${route.sourceId}:${Date.now()}`;
          const next = sourceDraftFromSource(source, owner);
          next.autoCheck = !next.autoCheck;
          setSourceDraft(next);
          setDirty(true);
          props.controller.replace({ name: 'sourceEdit', sourceId: route.sourceId, owner });
          return;
        }
        setSourceDraft({ ...draft, autoCheck: !draft.autoCheck });
        setDirty(true);
      } },
      { label: '查看修改汇总', description: draft && sourceDraftChanges(draft).length > 0 ? `${sourceDraftChanges(draft).length} 项未保存` : '尚无修改', disabled: draft && sourceDraftChanges(draft).length > 0 ? undefined : '请先修改来源设置', status: 'success', run: () => {
        if (!draft) return;
        setFocus(0);
        go({ name: 'sourceSave', owner: draft.owner });
      } },
    ];
    content = <Box flexDirection="column"><SectionCard title="当前设置" compact={policy.mode === 'compact'}>
      <StaticRow title="来源类型" meta={(draft?.type ?? detail?.type) === 'git' ? 'Git 仓库' : '本地目录'} compact />
    </SectionCard><SemanticRows actions={actions} focus={sourceTransportOverlay ? -1 : focus} kind="section" compact={policy.mode === 'compact'} /></Box>;
  } else if (route.name === 'sourceSave' && sourceDraft?.owner === route.owner) {
    const changes = sourceDraftChanges(sourceDraft);
    if (route.view === 'changes') {
      const lines = changeDetailLines(changes, size.columns - 4);
      const pageRows = Math.max(1, Math.min(
        responsiveBudget(5, 10),
        pageActionBudget(5),
      ));
      const detailOffset = Math.min(batchTargetOffset, Math.max(0, lines.length - 1));
      const visibleLines = lines.slice(detailOffset, detailOffset + pageRows);
      referenceDetailPagination = { total: lines.length, pageRows };
      breadcrumb = `插件来源 / ${sourceDraft.sourceId} / 完整变化`;
      context = `${Math.min(detailOffset + 1, lines.length)}–${Math.min(detailOffset + visibleLines.length, lines.length)} / ${lines.length}`;
      title = '完整来源变化';
      description = '逐项显示修改前和修改后的完整值。';
      help = 'p/n 或 PgUp/PgDn 阅读 · ↑↓ 移动 · Enter 选择 · Esc 返回修改汇总';
      actions = [
        ...paginationActions({
          offset: detailOffset,
          total: lines.length,
          pageRows,
          move: (direction) => moveBatchTargetPage(lines.length, pageRows, direction),
        }),
        { label: '返回修改汇总', run: back },
      ];
      content = <Box flexDirection="column">
        {detailOffset > 0 ? <StaticRow title={`↑ 前面还有 ${detailOffset} 行`} status="muted" compact /> : null}
        {visibleLines.map((line, index) => <StaticRow key={`${detailOffset + index}:${line}`} title={line} compact />)}
        {detailOffset + visibleLines.length < lines.length
          ? <StaticRow title={`↓ 后面还有 ${lines.length - detailOffset - visibleLines.length} 行`} status="muted" compact /> : null}
        <SemanticRows actions={actions} focus={focus} kind="action" compact />
      </Box>;
    } else {
    const savedSource = props.controller.getConfiguredSource(sourceDraft.sourceId);
    const protocolOnly = changes.length === 1 && changes[0]?.title === 'Git 仓库地址'
      && savedSource?.type === 'git'
      && (savedSource.url === OFFICIAL_CATALOG_SOURCE_URL
        || savedSource.url === OFFICIAL_CATALOG_SOURCE_SSH_URL)
      && (sourceDraft.location === OFFICIAL_CATALOG_SOURCE_URL
        || sourceDraft.location === OFFICIAL_CATALOG_SOURCE_SSH_URL);
    breadcrumb = `插件来源 / ${sourceDraft.sourceId} / 修改汇总`;
    context = `${changes.length} 项未保存`;
    title = sourceDraft.mode === 'add' ? `保存新来源 ${sourceDraft.sourceId}？` : `保存 ${sourceDraft.sourceId} 的修改？`;
    description = '选择是否在保存后验证候选并启用。保存成功与启用成功会分别报告。';
    actions = [
      ...(protocolOnly ? [] : [{ label: '保存并启用', description: '保存来源配置，再验证并切换当前目录版本', status: 'success' as const, run: () => beginSourceReview(sourceDraft, true) }]),
      { label: protocolOnly ? '只保存下载方式' : '只保存', description: '只保存来源配置；当前目录版本保持不变', status: protocolOnly ? 'success' : undefined, run: () => beginSourceReview(sourceDraft, false) },
      ...(protocolOnly ? [{ label: '保存并启用', description: '保存后验证并切换当前目录版本', run: () => beginSourceReview(sourceDraft, true) }] : []),
      { label: '阅读完整来源变化', description: '分页查看每项修改前和修改后的完整值', run: () => {
        setBatchTargetOffset(0);
        go({ ...route, view: 'changes' });
      } },
      { label: '返回修改', run: back },
    ];
    const sourceSummaryLimit = 1;
    const visibleChanges = changes.slice(0, sourceSummaryLimit);
    const sourceSaveActionViewport = actionViewport(actions, policy.mode === 'compact', focus,
      scrollOffset, pageActionBudget(3 + visibleChanges.length * 2));
    const changeSectionTitle = visibleChanges.length < changes.length
      ? `来源变化 · 显示 ${visibleChanges.length}/${changes.length}（另 ${changes.length - visibleChanges.length} 项）`
      : '来源变化';
    content = <Box flexDirection="column"><SectionCard title={changeSectionTitle} compact={policy.mode === 'compact'}>
      {visibleChanges.map((change) => <ReviewChangeRow key={change.title} title={`~ ${change.title}`} value={`${change.before ?? '未设置'} → ${change.after}`} compact />)}
    </SectionCard><SemanticRows actions={actions} focus={focus} kind="action" compact={policy.mode === 'compact'}
      offset={sourceSaveActionViewport.offset} limit={sourceSaveActionViewport.limit} /></Box>;
    }
  } else if (route.name === 'scriptTimeout' && pendingReviewIntent) {
    breadcrumb = '高级选项 / 安装前检查脚本';
    context = '毫秒';
    title = '设置脚本超时';
    description = `输入 ${SCRIPT_TIMEOUT_MIN_MS}–${SCRIPT_TIMEOUT_MAX_MS} 毫秒。默认 ${SCRIPT_TIMEOUT_DEFAULT_MS} 毫秒。`;
    help = '输入 · Enter 应用并重新显示操作汇总 · Ctrl-U 清空 · Esc 取消';
    content = <Box flexDirection="column">
      <InputCard focused title={<InputDisplay value={scriptTimeoutInput} columns={Math.max(8, size.columns - 8)} />} description={scriptTimeoutError ?? '此值只用于本次操作汇总。'} status={scriptTimeoutError ? 'error' : undefined} />
    </Box>;
  } else if (route.name === 'sourceRemoveBlocked') {
    breadcrumb = `插件来源 / ${route.sourceId} / 移除`;
    context = '已阻止'; title = `无法移除 ${route.sourceId}`;
    description = sourceReferenceSummary?.inventoryComplete === false ? '引用清单不完整，不能把未知引用当作零。' : '仍有内容依赖这个来源。';
    actions = [{ label: sourceDependenciesExpanded ? '收起依赖内容' : '查看依赖内容', description: '只显示插件、来源、平台、位置和类别聚合', run: () => {
      setSourceDependenciesExpanded((value) => !value);
      setBatchTargetOffset(0);
    } }, { label: '返回来源详情', run: back }];
    const countLabel = (value: number | undefined, unit: string): string => value === undefined ? '未知' : `${value} ${unit}`;
    const referenceLimit = Math.max(1, pageActionBudget(12));
    const references = sourceReferenceSummary?.dependencies ?? [];
    const referenceOffset = Math.min(batchTargetOffset, Math.max(0, references.length - 1));
    const visibleReferences = references.slice(referenceOffset, referenceOffset + referenceLimit);
    const hiddenReferences = Math.max(0, references.length - referenceOffset - visibleReferences.length);
    if (sourceDependenciesExpanded && references.length > referenceLimit) {
      actions.unshift(...paginationActions({
        offset: referenceOffset,
        total: references.length,
        pageRows: referenceLimit,
        move: (direction) => moveBatchTargetPage(references.length, referenceLimit, direction),
      }));
      referenceDetailPagination = { total: references.length, pageRows: referenceLimit };
      help = 'p/n 查看全部引用 · ↑↓ 移动 · Enter 选择 · Esc 返回';
    }
    content = <Box flexDirection="column">
      <Callout status="error" title={sourceReferenceSummary?.inventoryComplete === false ? '引用清单不完整' : '发现活动引用'} />
      <SectionCard title={sourceDependenciesExpanded
        ? referenceOffset > 0 ? `引用内容 · ↑ 前面还有 ${referenceOffset} 项` : '引用内容'
        : '引用汇总'}>
        {!sourceDependenciesExpanded ? <>
          <StaticRow title="安装位置" meta={countLabel(sourceReferenceSummary?.installationCount, '个')} />
          <StaticRow title="插件设置" meta={countLabel(sourceReferenceSummary?.configCount, '份')} />
          <StaticRow title="生命周期意图" meta={countLabel(sourceReferenceSummary?.lifecycleCount, '项')} />
          <StaticRow title="Marketplace" meta={countLabel(sourceReferenceSummary?.marketplaceCount, '个')} />
        </> : null}
        {sourceDependenciesExpanded ? visibleReferences.map((dependency, index) => <StaticRow key={`${dependency.category}:${dependency.pluginId ?? dependency.sourceId ?? referenceOffset + index}`} title={`${dependency.category} · ${dependency.pluginId ?? dependency.sourceId ?? '身份未知'}`} meta={`${dependency.platform ? platformLabel(dependency.platform) : ''}${dependency.scope ? ` · ${scopeLabel(dependency.scope)}` : ''}`} />) : null}
        {sourceDependenciesExpanded && hiddenReferences > 0 ? <StaticRow title={`↓ 后面还有 ${hiddenReferences} 项`} status="muted" compact /> : null}
      </SectionCard>
      <SemanticRows actions={actions} focus={focus} kind="action" compact={policy.mode === 'compact'} />
    </Box>;
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
        { label: '返回首页', run: () => requestSessionNavigation('home') },
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
      if (entry.id === 'refreshSource' && issue.sourceId) go({ name: 'sourceDetail', sourceId: issue.sourceId });
      else if (entry.id === 'retryLater') go({ name: 'issueList' });
      else if (entry.id === 'editSource' && issue.sourceId) go(issue.entity.kind === 'source'
        ? { name: 'sourceEdit', sourceId: issue.sourceId }
        : { name: 'sourceDetail', sourceId: issue.sourceId });
      else if (entry.id === 'reAddSource' && issue.sourceId) beginIssueSourceAdd(issue.sourceId);
      else if (entry.id === 'viewSourceChange' && issue.sourceId) go({ name: 'sourceTechnical', sourceId: issue.sourceId });
      else if (entry.id === 'openConfig' && issue.pluginId) {
        go({ name: 'configFields', pluginId: issue.pluginId, layer: { scope: 'effective' } });
      }
      else if (entry.id === 'viewDependencies' && issue.pluginId) {
        go({ name: 'pluginDependencies', pluginId: issue.pluginId });
      }
      else if (entry.id === 'viewDependencyIssue' && entry.pluginId) {
        const dependencyIssue = props.controller.listUserIssues().find((candidate) =>
          issueMatchesTarget(candidate, entry.pluginId!, issue.dependencyPlatform, issue.dependencyScope)
          && candidate.issueId !== issue.issueId);
        if (dependencyIssue) go({ name: 'issueDetail', issueId: dependencyIssue.issueId });
        else if (!showTechnical) toggleTechnical();
      }
      else toggleTechnical();
    };
    const issueHasTechnicalDetails = Boolean(issue.diagnostic.technical);
    actions = issue.actions.filter((entry) => entry.id !== 'viewTechnical' || issueHasTechnicalDetails).map((entry) => ({
      label: entry.id === 'viewTechnical' && showTechnical ? '返回问题摘要' : entry.label,
      description: entry.description,
      status: entry.id === 'remove'
        || entry.id === 'keepUserScope' || entry.id === 'keepProjectScope' ? 'error' as const : undefined,
      run: () => runIssueAction(entry),
    }));
    const issueDetailRows = diagnosticDetailRowCount(issue.diagnostic);
    const issueDetailPageRows = policy.mode === 'compact'
      ? 1
      : Math.max(1, responsiveBudget(5, 10) - 2);
    const issuePaginationActions = showTechnical && issueDetailRows > issueDetailPageRows
      ? paginationActions({
          offset: batchTargetOffset,
          total: issueDetailRows,
          pageRows: issueDetailPageRows,
          move: (direction) => moveBatchTargetPage(issueDetailRows, issueDetailPageRows, direction),
        })
      : [];
    actions.push(...issuePaginationActions);
    if (issuePaginationActions.length > 0) {
      referenceDetailPagination = { total: issueDetailRows, pageRows: issueDetailPageRows };
      help = 'p/n 查看全部技术字段 · ↑↓ 移动 · Enter 选择 · Esc 返回';
    }
    const issuePlugin = issue.pluginId ? props.controller.getPluginOverview(issue.pluginId) : undefined;
    const issueOverview = issue.pluginId ? props.controller.getPluginDependencyOverview(issue.pluginId) : undefined;
    const issueDiagnosticSummary = <DiagnosticSummary
      diagnostic={issue.diagnostic}
      technical={showTechnical}
      offset={showTechnical ? batchTargetOffset : undefined}
      limit={showTechnical ? issueDetailPageRows : undefined}
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
        ...(issueHasTechnicalDetails ? [{ label: showTechnical ? '隐藏技术详情' : '技术详情', run: () => toggleTechnical() }] : []),
        ...issuePaginationActions,
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
          props.controller.beginInstallFlow(issuePlugin.pluginId, issueScope);
          props.controller.setInstallPlatforms([entry.platform]);
          go({ name: 'installTargets', pluginId: issuePlugin.pluginId });
        } })),
        { label: '返回调整目标平台', run: () => {
          setScope(issueScope);
          setSelectedTargets([]);
          props.controller.beginInstallFlow(issuePlugin.pluginId, issueScope);
          go({ name: 'installTargets', pluginId: issuePlugin.pluginId });
        } },
        { label: '查看依赖关系', run: () => go({ name: 'pluginDependencies', pluginId: issuePlugin.pluginId }) },
        ...(issueHasTechnicalDetails ? [{ label: showTechnical ? '隐藏技术详情' : '技术详情', run: () => toggleTechnical() }] : []),
        ...issuePaginationActions,
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
  } else if (route.name === 'operationHistory') {
    const records = snapshot.operationHistorySummaries;
    breadcrumb = '操作记录';
    context = `本次会话 · ${records.length} 项`;
    title = records.length === 0 ? '还没有操作记录' : '最近操作';
    description = records.length === 0
      ? '完成操作或遇到问题后，安全摘要会保留在这里。'
      : '记录只包含安全摘要，不携带可重放的确认票据。';
    actions = records.length === 0
      ? [{ label: '返回首页', run: () => requestSessionNavigation('home') }]
      : [
          ...records.map((record) => ({
            label: record.message,
            description: `${operationHistoryState(record).label} · ${record.diagnosticCount} 项安全诊断`,
            meta: operationHistoryMeta(record),
            status: operationHistoryState(record).status,
            run: () => go({ name: 'operationDiagnostic', recordId: record.recordId }),
          })),
          { label: '返回上一页', run: back },
        ];
    const viewport = actionViewport(
      actions,
      policy.mode === 'compact',
      focus,
      scrollOffset,
      pageActionBudget(4),
    );
    content = <Box flexDirection="column">
      <StatusCard
        status={records.some((record) => record.state !== 'succeeded') ? 'warning' : 'success'}
        title={records.length === 0 ? '没有可回看的安全结果' : '操作结果与问题'}
        description="选择一项可查看完整安全详情或报告预览。"
        compact={policy.mode === 'compact'}
      />
      <SemanticRows
        actions={actions}
        focus={focus}
        kind="action"
        compact={policy.mode === 'compact'}
        offset={viewport.offset}
        limit={viewport.limit}
      />
    </Box>;
  } else if (route.name === 'operationDiagnostic') {
    const detail = props.controller.getOperationDiagnostic(route.recordId);
    breadcrumb = '操作记录 / 技术详情';
    context = 'p 上一页 · n 下一页';
    title = detail ? '安全技术详情' : '操作记录已不可用';
    description = detail
      ? '可滚动查看所有目标、阶段、代码和已保留的安全原因。'
      : '这项会话记录已经不再可用。';
    const preview = detail ? props.controller.previewOperationReport(route.recordId) : undefined;
    const detailLineLimit = 2;
    const detailLines = detail ? operationDiagnosticLineCount(detail) : 0;
    const lastDetailOffset = Math.max(0, detailLines - detailLineLimit);
    actions = detail ? [
      preview
        ? { label: '预览安全报告', description: '确认内容后选择本地保存位置', run: () => go({ name: 'operationReportPreview', recordId: route.recordId }) }
        : { label: '报告当前不可用', disabled: '无法生成这项记录的报告' },
      { label: 'p 上一页', run: () => setScrollOffset((value) => Math.max(0, value - detailLineLimit)) },
      { label: 'n 下一页', run: () => setScrollOffset((value) => Math.min(lastDetailOffset, value + detailLineLimit)) },
      { label: '返回操作记录', run: back },
    ] : [{ label: '返回操作记录', run: back }];
    const diagnosticActionViewport = actionViewport(actions, policy.mode === 'compact', focus, 0,
      policy.mode === 'compact' ? 2 : 3);
    content = detail ? <Box flexDirection="column">
      <ContentViewport><OperationDiagnosticScreen
        detail={detail}
        compact={policy.mode === 'compact'}
        offset={scrollOffset}
        limit={detailLineLimit}
      /></ContentViewport>
      <SemanticRows actions={actions} focus={focus} kind="action" compact={policy.mode === 'compact'}
        offset={diagnosticActionViewport.offset} limit={diagnosticActionViewport.limit} />
    </Box> : <Box flexDirection="column">
      <Callout status="warning" title="记录已不可用" description="返回操作记录后可查看仍在本次会话中的结果。" />
      <SemanticRows actions={actions} focus={focus} kind="action" compact={policy.mode === 'compact'} />
    </Box>;
  } else if (route.name === 'operationReportPreview') {
    const preview = props.controller.previewOperationReport(route.recordId);
    breadcrumb = '操作记录 / 报告预览';
    context = 'p 上一页 · n 下一页';
    title = reportSaveMode ? '选择报告保存位置' : preview ? '安全报告预览' : '报告已不可用';
    description = reportSaveMode
      ? '输入一个新的本地文件路径，然后按 Enter 保存。'
      : preview
        ? '保存前请确认报告内容。不会自动上传或发送。'
        : '这项会话报告已经不再可用。';
    if (reportSaveMode && preview) {
      help = 'Enter 保存 · Ctrl-U 清空输入 · Esc 返回报告预览';
      content = <Box flexDirection="column">
        <InputCard title="本地文件路径" focused compact={policy.mode === 'compact'}>
          <InputDisplay
            value={reportSavePath}
            placeholder="/tmp/aw-operation-report.md"
            columns={Math.max(12, size.columns - 10)}
          />
        </InputCard>
        {reportSaveError ? <Callout status="error" title="报告未保存" description={reportSaveError} compact={policy.mode === 'compact'} /> : null}
        <StaticRow title="仅保存当前预览中的安全内容。" status="muted" compact />
      </Box>;
    } else if (preview) {
      const reportLineLimit = 2;
      const reportLines = operationReportLineCount(preview);
      const lastReportOffset = Math.max(0, reportLines - reportLineLimit);
      actions = [
        { label: '选择本地保存位置', description: '保存前输入明确的文件路径', run: () => {
          setReportSaveMode(true);
          setReportSaveError(undefined);
          setReportSaveResult(undefined);
        } },
        { label: '保存到临时目录', description: '使用唯一的临时文件名保存当前安全报告', run: () => {
          void props.controller.saveOperationReport(route.recordId).then(() => {
            setReportSaveResult('报告已保存到临时目录。');
            setReportSaveError(undefined);
          }).catch(() => {
            setReportSaveError('报告未保存。请检查保存位置后重试。');
          });
        } },
        { label: 'p 上一页', run: () => setScrollOffset((value) => Math.max(0, value - reportLineLimit)) },
        { label: 'n 下一页', run: () => setScrollOffset((value) => Math.min(lastReportOffset, value + reportLineLimit)) },
        { label: '返回技术详情', run: back },
      ];
      const reportFeedbackVisible = Boolean(reportSaveResult || reportSaveError);
      const compactReportActions = policy.mode === 'compact' || reportFeedbackVisible;
      const reportActionLimit = policy.mode === 'compact' || reportFeedbackVisible ? 2 : 3;
      const reportActionOffset = Math.min(
        Math.max(0, focus - 1),
        Math.max(0, actions.length - reportActionLimit),
      );
      content = <Box flexDirection="column">
        <ContentViewport><OperationReportPreviewScreen
          preview={preview}
          compact={policy.mode === 'compact'}
          offset={scrollOffset}
          limit={reportLineLimit}
        /></ContentViewport>
        {reportSaveResult ? <Callout status="success" title="报告已保存" description={reportSaveResult} compact={policy.mode === 'compact'} /> : null}
        {reportSaveError ? <Callout status="error" title="报告未保存" description={reportSaveError} compact={policy.mode === 'compact'} /> : null}
        <SemanticRows actions={actions} focus={focus} kind="action" compact={compactReportActions}
          offset={reportActionOffset} limit={reportActionLimit} />
      </Box>;
    } else {
      actions = [{ label: '返回技术详情', run: back }];
      content = <Box flexDirection="column">
        <Callout status="warning" title="报告已不可用" description="返回技术详情后可查看仍在本次会话中的记录。" />
        <SemanticRows actions={actions} focus={focus} kind="action" compact={policy.mode === 'compact'} />
      </Box>;
    }
  } else if (route.name === 'reviewPreparing' && snapshot.reviewPreparation) {
    const preparation = snapshot.reviewPreparation;
    const labels = preparation.operationKind === 'pluginWriteTask'
      ? ['插件任务', '正在准备任务影响确认']
      : preparation.operationKind === 'portableInstall'
      ? ['通用 Skills / 安装', '正在准备通用 Skills 安装确认']
      : preparation.operationKind === 'configSave' || preparation.operationKind === 'configSaveBatch'
        || preparation.operationKind === 'configReset'
        ? ['设置', '正在准备设置确认']
        : preparation.operationKind === 'sourceMutation' || preparation.operationKind === 'catalogGeneration'
          ? ['插件来源', '正在准备来源变更确认']
          : ['插件操作', '正在准备插件操作确认'];
    breadcrumb = `${labels[0]} / 准备确认`;
    context = '只读';
    title = preparation.state === 'failed' ? '无法准备确认信息' : labels[1]!;
    const refreshPreparation = preparation.operationKind === 'pluginWrite'
      && preparation.stages.some((stage) => stage.id === 'refresh');
    description = preparation.state === 'failed'
      ? preparation.message ?? '无法准备确认信息。请返回检查选择，或重试。'
      : refreshPreparation
        ? '先刷新相关来源的当前状态，再读取并验证新的同步计划；不会修改插件安装或设置。'
        : '这个阶段只读取和验证状态，不会修改任何安装或设置。';
    help = preparation.state === 'running'
      ? 'Esc 取消 · Ctrl-C 完成后退出'
      : '↑↓ 移动 · Enter 选择 · Esc 返回';
    actions = preparation.state === 'failed' ? [
      ...[...new Map((preparation.operationRecordId
        ? props.controller.getOperationDiagnostic(preparation.operationRecordId)?.diagnostics ?? []
        : []).flatMap((diagnostic) => diagnostic.stage === 'dependencyPlan'
          && diagnostic.target?.pluginId
          && props.controller.getPluginOverview(diagnostic.target.pluginId)
          ? [[`${diagnostic.target.pluginId}:${diagnostic.target.platform}`, diagnostic.target] as const]
          : [])).values()].map((target): ActionItem => ({
            label: `处理 ${props.controller.getPluginOverview(target.pluginId!)!.displayName}`,
            description: '查看这个依赖的问题和可用的恢复操作',
            run: () => go({ name: 'platform', pluginId: target.pluginId!, platform: target.platform }),
          })),
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
      {preparation.subject ? <StaticRow title="当前" meta={preparation.subject} status="muted" /> : null}
      {preparation.code && preparation.message
        ? <Callout status="error" title="确认信息未准备完成" description={preparation.message} /> : null}
      {showTechnical && preparation.code
        ? <TechnicalDetails><StaticRow title="failure code" meta={preparation.code} compact /></TechnicalDetails> : null}
      {actions.length > 0 ? <SemanticRows actions={actions} focus={focus} kind="action" compact={policy.mode === 'compact'} /> : null}
    </Box>;
  } else if (route.name === 'review' && snapshot.activeReview) {
    const review = snapshot.activeReview;
    const technicalDetails = (review.technicalDetails ?? []).flatMap((detail) =>
      review.operationKind === 'catalogGeneration' && detail.startsWith('引用影响：')
        ? wrapConsoleText(detail, Math.max(20, size.columns - 10))
        : [detail]);
    const catalogReferenceDetailOffset = review.operationKind === 'catalogGeneration'
      ? technicalDetails.findIndex((detail) => detail.startsWith('引用影响：'))
      : -1;
    const portableUserConfirmation = review.operationKind === 'portableInstall'
      && snapshot.portableDraft?.scope === 'user';
    const requiresIndependentConfirmation = review.requiresConfirmation || portableUserConfirmation;
    const installReviewPluginId = pendingReviewIntent?.kind === 'pluginWrite'
      && pendingReviewIntent.action === 'install'
      ? pendingReviewIntent.pluginId
      : review.pluginAction === 'install' ? snapshot.installPlacementDraft?.pluginId : undefined;
    const batchReview = review.operationKind === 'pluginWriteBatch';
    const taskReview = review.operationKind === 'pluginWriteTask';
    const exactProjectSyncReview = batchReview && review.pluginAction === 'sync'
      && review.changes.some((change) => change.group === 'requested'
        && change.description?.includes('当前项目'));
    const projectPreApplyConfirmation = review.changes.some((change) =>
      change.kind === 'warning' && change.title.endsWith('当前项目同步目标将运行 preApply'));
    breadcrumb = `${review.subject.name} / ${review.title}`;
    title = `${snapshot.result?.state === 'stale' ? '状态已变化 · ' : ''}${review.operationKind === 'portableInstall' || taskReview
      ? review.title : `确认${review.title}`}${review.operationKind === 'catalogStorePrune' ? '' : ` ${review.subject.name}`}`;
    description = snapshot.result?.state === 'stale'
      ? '当前状态已变化。请检查新的变化后再次确认。'
      : review.description;
    if (taskReview) {
      context = '本次选择 · 用户任务';
      help = 'PgUp/PgDn 查看全部影响 · ↑↓ 移动 · Enter 选择 · Esc 返回';
    } else if (batchReview) {
      context = `${review.batch?.requestedPluginIds.length ?? 0} 个根插件 · ${review.batch?.groupCount ?? 0} 组`;
      help = 'PgUp/PgDn 查看全部根插件和依赖 · ↑↓ 移动 · Enter 选择 · Esc 返回';
    }
    actions = [
      { label: review.primaryLabel, description: requiresIndependentConfirmation
        ? '打开独立风险确认；执行时再次检查当前状态'
        : '执行前将再次检查当前状态', status: review.destructive ? 'error' : undefined, run: () => {
        if (requiresIndependentConfirmation) {
          setOperationConfirmation({
            reviewToken: review.reviewToken,
            returnFocus: focus,
            returnScrollOffset: scrollOffset,
            warningOffset: 0,
          });
          setOverlayFocus(0);
          return;
        }
        if (operationBusy.current) return;
        operationBusy.current = true;
        return props.controller.executeOperation(review.reviewToken).then(() => {
          setFocus(0);
          setScrollOffset(0);
        }).finally(() => {
          operationBusy.current = false;
        });
      } },
      ...(!showTechnical && catalogReferenceDetailOffset >= 0 ? [{
        label: '查看完整引用影响',
        description: '逐项查看安装、设置、生命周期和 Marketplace 引用',
        run: () => {
          setShowTechnical(true);
          setBatchTargetOffset(catalogReferenceDetailOffset);
          setFocus(0);
          setScrollOffset(0);
        },
      }] : []),
      ...(taskReview
        && pendingReviewIntent?.kind === 'pluginWriteTask'
        && pendingReviewIntent.goal === 'update'
        && batchDraft?.frozenPluginIds ? [{
          label: `调整选择（${new Set(pendingReviewIntent.targets
            .map((target) => target.pluginId)).size}）`,
          description: '只可删减或恢复本次推荐插件；调整后重新读取状态并显示操作汇总',
          run: () => {
            if (!props.controller.returnToPluginWriteTaskBatchSelection(batchDraft.flowId)) {
              setActionError('推荐选择已失效。请返回我的插件重新开始。');
              return;
            }
            setBatchDraft((current) => current ? {
              ...current,
              stage: 'select',
              showSelected: false,
            } : current);
            setFocus(0);
            setScrollOffset(0);
            setShowTechnical(false);
            setActionError(undefined);
          },
        }] : []),
      ...(taskReview
        && pendingReviewIntent?.kind === 'pluginWriteTask'
        && route.name === 'review'
        && batchDraft ? [{
          label: '修改处理范围',
          description: '只可删减或恢复本次已有位置；修改后重新读取证据',
          run: () => {
            const targets = pendingReviewIntent.targets;
            setBatchDraft((current) => current ? {
              ...current,
              maintenanceGoal: pendingReviewIntent.goal,
              maintenanceTargets: current.maintenanceGoal === pendingReviewIntent.goal
                && current.maintenanceTargets
                ? current.maintenanceTargets : targets,
              selectedMaintenanceTargetKeys: targets.map(batchTargetKey),
            } : current);
            back();
            props.controller.push({ name: 'batchPlacement' });
            setFocus(0);
            setScrollOffset(0);
          },
        }] : []),
      ...(batchReview
        && pendingReviewIntent?.kind === 'pluginWriteBatch'
        && pendingReviewIntent.selection.kind === 'targets'
        && pendingReviewIntent.action !== 'install'
        && batchDraft?.maintenanceTargets ? [{
          label: '修改处理范围',
          description: '只可删减或恢复本次已有位置；修改后重新读取证据',
          run: () => {
            back();
            props.controller.push({ name: 'batchPlacement' });
            setFocus(0);
            setScrollOffset(0);
          },
        }] : []),
      ...(installReviewPluginId
        && (snapshot.installPlacementDraft?.targets.length ?? 0) > 0 ? [{
          label: '查看/调整依赖位置',
          description: '当前已自动安排依赖位置；调整后会重新显示操作汇总',
          run: () => {
            props.controller.push({
              name: 'dependencyPlacement',
              pluginId: installReviewPluginId,
            });
            setFocus(0);
            setScrollOffset(0);
          },
        }] : []),
      ...(supportsScriptTimeout(pendingReviewIntent) ? [{
        label: '高级选项：脚本超时',
        description: `${pendingReviewIntent.scriptTimeoutMs ?? SCRIPT_TIMEOUT_DEFAULT_MS} 毫秒`,
        run: () => {
          back();
          go({ name: 'scriptTimeout', owner: review.reviewToken });
        },
      }] : []),
      { label: '返回修改', run: review.operationKind === 'portableInstall' && snapshot.portableDraft
        ? async () => {
            if (await refreshPortableDraft(snapshot.portableDraft!.pluginId)) back();
          }
        : back },
    ];
    const groupedChanges = review.changes.some((change) => change.group);
    const compressedReview = policy.mode === 'compact';
    const groupTitle = {
      requested: review.operationKind === 'portableInstall' ? '已选择 Skills · 当前插件' : '你选择的插件',
      dependencies: review.operationKind === 'portableInstall' ? '已选择 Skills · 来自依赖插件' : '必需依赖',
      projectIntent: '当前项目使用设置',
      userIntent: '所有项目使用设置',
      sharedCodexNative: 'Codex 平台共享内容',
      userActivation: '所有项目启用位置',
      projectActivation: '当前项目启用位置',
      awExtensions: 'AW 管理附加能力',
      runtime: '执行设置',
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
    const technicalGroups = new Set([
      'projectIntent', 'userIntent', 'sharedCodexNative',
      'userActivation', 'projectActivation', 'awExtensions', 'runtime',
    ]);
    const userReviewChanges = review.changes.filter((change) =>
      change.group === undefined
      || !isTechnicalReviewGroup(change.group)
      || change.kind === 'warning'
      || change.kind === 'remove');
    const visibleSpecs = groupedSpecs.map((group) => technicalGroups.has(group.key) ? {
      ...group,
      label: '风险',
      changes: group.changes.filter((change) => change.kind === 'warning' || change.kind === 'remove'),
    } : group).filter((group) => group.changes.length > 0);
    const headingLines = compressedReview ? 0 : visibleSpecs.filter((group) => group.label).length;
    const staticRowBudget = Math.max(visibleSpecs.length, responsiveBudget(7, 12) - headingLines);
    const reviewPaginationTotal = showTechnical
      ? Math.max(review.changes.length, technicalDetails.length)
      : userReviewChanges.length;
    const reviewPageRows = Math.max(1, responsiveBudget(6, 10) - actions.length - 2);
    if (reviewPaginationTotal > reviewPageRows) {
      actions.push(...paginationActions({
        offset: batchTargetOffset,
        total: reviewPaginationTotal,
        pageRows: 1,
        move: (direction) => moveBatchTargetPage(reviewPaginationTotal, 1, direction),
      }));
      referenceDetailPagination = { total: reviewPaginationTotal, pageRows: 1 };
    }
    const reviewActionViewport = actionViewport(
      actions,
      true,
      focus,
      scrollOffset,
      responsiveBudget(2, 6),
    );
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
    const standardChangeGroups = visibleSpecs.map((group) => {
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
    const portableReview = review.operationKind === 'portableInstall';
    const batchChangeLimit = portableReview
      ? responsiveBudget(3, 5)
      : policy.mode === 'compact' ? 1 : Math.max(1,
          responsiveBudget(6, 10) - reviewActionViewport.limit);
    const batchChanges = userReviewChanges.slice(batchTargetOffset, batchTargetOffset + batchChangeLimit);
    const batchHiddenBefore = batchTargetOffset;
    const prioritizedReviewChanges = portableReview ? [
      ...userReviewChanges.filter((change) => change.kind === 'warning'),
      ...userReviewChanges.filter((change) => change.kind !== 'warning'
        && change.group === 'portableTarget'),
      ...userReviewChanges.filter((change) => change.kind !== 'warning'
        && change.group !== 'portableTarget'),
    ] : [
      ...userReviewChanges.filter((change) => change.kind === 'warning'),
      ...userReviewChanges.filter((change) => change.kind !== 'warning'),
    ];
    const pagedReviewChanges = prioritizedReviewChanges.slice(batchTargetOffset,
      batchTargetOffset + batchChangeLimit);
    const changeGroups = portableReview || batchReview || userReviewChanges.length > staticRowBudget
      ? <Box flexDirection="column">
          {batchHiddenBefore > 0 ? <StaticRow title={`↑ 前面还有 ${batchHiddenBefore} 项`} status="muted" compact /> : null}
          {(batchReview ? batchChanges : pagedReviewChanges).map((change, index) => <ReviewChangeRow
            key={`${change.batchGroupId ?? ''}:${change.pluginId ?? change.title}:${index}`}
            title={`${[
              portableReview && change.group ? groupTitle[change.group] : undefined,
              change.sourceId,
              change.relation === 'requested' ? '根插件'
                : change.relation === 'direct' ? '直接依赖'
                  : change.relation === 'transitive' ? '间接依赖' : undefined,
            ].filter(Boolean).join(' · ')}${portableReview && change.group || change.sourceId || change.relation ? ' · ' : ''}${reviewSymbol(change)} ${change.title}`}
            description={(portableReview && change.kind !== 'warning') || exactProjectSyncReview
              ? change.description : undefined}
            meta={portableReview || exactProjectSyncReview ? undefined : change.description}
      status={changeStatus(change)}
            compact={!portableReview && !exactProjectSyncReview}
          />)}
          {Math.max(0, userReviewChanges.length - batchTargetOffset - (batchReview ? batchChanges : pagedReviewChanges).length) > 0 ? <StaticRow title={`↓ 后面还有 ${Math.max(0, userReviewChanges.length - batchTargetOffset - (batchReview ? batchChanges : pagedReviewChanges).length)} 项`} status="muted" compact /> : null}
        </Box>
      : standardChangeGroups;
    const technicalDetailLimit = responsiveBudget(1, 1);
    const visibleTechnicalDetails = technicalDetails.slice(batchTargetOffset,
      batchTargetOffset + technicalDetailLimit);
    const hiddenTechnicalDetails = Math.max(0,
      technicalDetails.length - batchTargetOffset - visibleTechnicalDetails.length);
    const technicalCardRows = 3 + visibleTechnicalDetails.length;
    const technicalChangeBudget = Math.max(1, Math.floor(
      (size.rows - 8 - 3 - (review.equivalentCommand ? 1 : 0)
        - reviewActionViewport.limit - technicalCardRows) / 2));
    const prioritizedTechnicalChanges = [
      ...review.changes.filter((change) => change.kind === 'warning'),
      ...review.changes.filter((change) => change.kind !== 'warning'
        && change.group !== undefined && technicalGroups.has(change.group)),
      ...review.changes.filter((change) => change.kind !== 'warning'
        && change.group === 'portableTarget'),
      ...review.changes.filter((change) => change.kind !== 'warning'
        && change.group !== 'portableTarget'
        && (change.group === undefined || !technicalGroups.has(change.group))),
    ];
    const visibleTechnicalChanges = prioritizedTechnicalChanges.slice(batchTargetOffset,
      batchTargetOffset + technicalChangeBudget);
    const hiddenTechnicalChanges = Math.max(0,
      review.changes.length - batchTargetOffset - visibleTechnicalChanges.length);
    const technicalChanges = visibleTechnicalChanges.map((change, index) => {
      const category = change.group ? groupTitle[change.group] : undefined;
      return <ReviewChangeRow
        key={`${change.title}:${index}`}
        title={category
          ? `${category} · ${reviewSymbol(change)} ${change.title}`
          : `${reviewSymbol(change)} ${change.title}`}
        description={change.description}
        meta={index === visibleTechnicalChanges.length - 1 && hiddenTechnicalChanges > 0
          ? `另有 ${hiddenTechnicalChanges} 项` : undefined}
      status={changeStatus(change)}
        compact={false}
      />;
    });
    const showEquivalentCommand = Boolean(review.equivalentCommand && showTechnical && !review.requiresConfirmation);
    const installDependencyTargets = installReviewPluginId
      ? snapshot.installPlacementDraft?.targets ?? [] : [];
    const installDependencyPluginIds = new Set(installDependencyTargets.map((target) => target.pluginId));
    const reusedDependencyPluginIds = new Set(installDependencyTargets
      .filter((target) => target.action === 'keep')
      .map((target) => target.pluginId));
    const newDependencyCount = [...installDependencyPluginIds]
      .filter((pluginId) => !reusedDependencyPluginIds.has(pluginId)).length;
    const widenedDependencyCount = new Set(installDependencyTargets
      .filter((target) => target.affectsOtherProjects && target.action !== 'keep')
      .map((target) => target.pluginId)).size;
    if (userReviewChanges.length > staticRowBudget || showTechnical
      && (review.changes.length > technicalChangeBudget || technicalDetails.length > technicalDetailLimit)) {
      help = 'PgUp/PgDn 查看全部确认信息 · ↑↓ 移动 · Enter 选择 · Esc 返回';
    }
    content = <Box flexDirection="column"><ReviewCard title={review.subject.name} meta={`${review.subject.sourceLabel ?? ''} ${review.subject.version ?? ''}`} description={showEquivalentCommand ? review.description : undefined}>{showEquivalentCommand ? <Text>等价命令：{review.equivalentCommand}</Text> : null}{portableReview ? <SemanticRows actions={actions} focus={operationConfirmation ? -1 : focus} kind="action" compact offset={reviewActionViewport.offset} limit={reviewActionViewport.limit} /> : null}{showTechnical && review.catalogBinding ? <><StaticRow title={`Catalog：${review.catalogBinding.sourceId} ${review.catalogBinding.catalogVersion} · 当前使用`} meta={`generation ${review.catalogBinding.generationDigestShort}`} status="success" compact /><StaticRow title="操作期间不检查远端 Catalog" status="success" compact /></> : null}{installDependencyPluginIds.size > 0 ? <><StaticRow
      title={`需要 ${installDependencyPluginIds.size} 个额外插件；${reusedDependencyPluginIds.size} 个复用、${newDependencyCount} 个新增`}
      status="info" compact /><StaticRow
      title={widenedDependencyCount > 0 ? `${widenedDependencyCount} 个依赖会扩大到所有项目` : '没有依赖会扩大到所有项目'}
      status={widenedDependencyCount > 0 ? 'warning' : 'success'} compact /></> : null}{review.requiresConfirmation ? <StaticRow title={review.operationKind === 'catalogStorePrune' ? '! 需要确认删除本次预览的可回收项目' : projectPreApplyConfirmation ? '! 需要确认当前项目同步脚本' : '! 需要确认会影响其他项目的内容'} meta={review.sharedImpact.pluginIds.length > 0 ? `${review.sharedImpact.pluginIds.length} 个插件` : undefined} description={review.sharedImpact.warning} status="warning" compact /> : null}{showTechnical ? technicalChanges : changeGroups}{portableReview ? null : <SemanticRows actions={actions} focus={operationConfirmation ? -1 : focus} kind="action" compact offset={reviewActionViewport.offset} limit={reviewActionViewport.limit} />}{compressedReview || showTechnical ? null : <StaticRow title="技术详情（d）" status="muted" />}{showTechnical ? <TechnicalDetails>{visibleTechnicalDetails.map((detail, index) => <StaticRow key={`${batchTargetOffset + index}:${detail}`} title={detail} meta={catalogReferenceDetailOffset >= 0 && batchTargetOffset + index >= catalogReferenceDetailOffset ? undefined : index === visibleTechnicalDetails.length - 1 && hiddenTechnicalDetails > 0 ? `另有 ${hiddenTechnicalDetails} 项` : undefined} compact />)}</TechnicalDetails> : null}</ReviewCard></Box>;
  } else if (route.name === 'progress') {
    const taskOperation = snapshot.activeReview?.operationKind === 'pluginWriteTask';
    const portableOperation = snapshot.activeReview?.operationKind === 'portableInstall';
    const configOperation = snapshot.activeReview?.operationKind === 'configSave'
      || snapshot.activeReview?.operationKind === 'configSaveBatch'
      || snapshot.activeReview?.operationKind === 'configReset';
    const sourceOperation = snapshot.activeReview?.operationKind === 'sourceMutation'
      || snapshot.activeReview?.operationKind === 'catalogGeneration'
      || snapshot.activeReview?.operationKind === 'catalogSourcesRecovery';
    const storeOperation = snapshot.activeReview?.operationKind === 'catalogStorePrune';
    const issueOperation = snapshot.activeReview?.originIssue;
    breadcrumb = taskOperation ? '插件任务 / 进度' : portableOperation ? '通用 Skills / 进度' : issueOperation ? '需要处理 / 进度' : storeOperation ? '本地存储 / 清理' : sourceOperation ? '插件来源 / 保存' : configOperation ? '设置 / 进度' : '插件操作 / 进度';
    const configApply = (snapshot.activeReview?.operationKind === 'configSave'
      || snapshot.activeReview?.operationKind === 'configSaveBatch')
      && snapshot.activeReview.changes.some((change) => change.group === 'configImpact' && change.kind === 'change');
    const progressAction = snapshot.activeReview?.taskGoal === 'restore' ? '恢复'
      : snapshot.activeReview?.taskGoal === 'update' ? '更新'
        : configApply ? '应用设置'
          : snapshot.activeReview?.pluginAction === 'install' ? '添加'
            : snapshot.activeReview?.pluginAction === 'refreshAndSync' ? '更新'
              : snapshot.activeReview?.pluginAction === 'reinstall' ? '恢复'
                : snapshot.activeReview?.pluginAction === 'uninstall' ? '移除'
                  : snapshot.activeReview?.pluginAction === 'cleanup' ? '清理'
                    : snapshot.activeReview?.pluginAction === 'sync' ? '同步' : '处理';
    const catalogGenerationOperation = snapshot.activeReview?.operationKind === 'catalogGeneration';
    const catalogSourcesRecovery = snapshot.activeReview?.operationKind === 'catalogSourcesRecovery';
    title = taskOperation ? `正在${progressAction}插件` : portableOperation ? '正在安装通用 Skills' : issueOperation ? `正在${progressAction}插件`
      : storeOperation ? '正在清理 Catalog 本地存储'
      : catalogGenerationOperation ? '正在验证并启用目录版本'
        : catalogSourcesRecovery ? '正在恢复插件来源配置'
        : sourceOperation ? '正在保存来源配置'
          : configOperation ? configApply ? '正在保存并应用设置' : '正在保存设置'
            : `正在${progressAction}插件`;
    description = issueOperation ? '完成后会重新读取状态并检查问题。'
      : storeOperation ? '只处理确认页冻结的精确项目，并在删除前重新检查。'
      : catalogGenerationOperation ? '正在验证并应用已确认的目录版本操作。'
        : catalogSourcesRecovery ? '正在备份损坏配置并恢复官方默认来源。'
        : sourceOperation ? '只原子保存来源配置，不访问网络。'
          : configOperation ? configApply ? '先保存所选层，再重新应用当前可见安装位置。' : '只保存所选设置层。'
            : snapshot.activeReview?.operationKind === 'pluginWriteBatch'
              && snapshot.activeReview.pluginAction === 'sync'
              ? '只同步确认页中的精确目标；不会自动升级插件来源。'
              : '请勿关闭当前终端。';
    const batchProgress = snapshot.activeReview?.operationKind === 'pluginWriteBatch' || taskOperation;
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
      if (entry.state === 'running') return { label: `正在${progressAction}`, status: 'info' };
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
    help = prioritizedProgressTargets.length > progressTargetLimit
      ? 'PgUp/PgDn 查看全部目标 · Ctrl-C 完成后退出' : 'Ctrl-C 完成后退出';
    const progressTargetOffset = Math.min(batchTargetOffset,
      Math.max(0, prioritizedProgressTargets.length - 1));
    const visibleProgressTargets = prioritizedProgressTargets.slice(
      progressTargetOffset,
      progressTargetOffset + progressTargetLimit,
    );
    const hiddenProgressTargets = Math.max(
      0,
      snapshot.progressTargets.length - progressTargetOffset - visibleProgressTargets.length,
    );
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
      <ProgressRow title="生成已选候选 Skills" description={`${portableProviderCount} 个来源或依赖插件提供 ${portableSelectedCount} 个 Skills`} meta={portableProgressMeta(1)} state={portableProgressState(1)} compact={compactPortableProgress} />
      <ProgressRow title={`安装已选择的 ${portableSelectedCount} 个 Skills`} description={`Agent：${portableDraft?.agentMode === 'explicit' ? portableDraft.requestedAgents.join('、') : 'Skills CLI 默认选择'}`} meta={portableProgressMeta(2)} state={portableProgressState(2)} compact={compactPortableProgress} />
      <ProgressRow title="验证结果" description="逐项确认所选 Skill 的安装目标" meta={portableProgressMeta(3)} state={portableProgressState(3)} compact={compactPortableProgress} />
      {showTechnical ? <TechnicalDetails>{technicalMessages.map((message, index) => <StaticRow key={`${index}:${message}`} title={message} compact />)}{hiddenTechnicalMessages > 0 ? <StaticRow title={`另有 ${hiddenTechnicalMessages} 条技术消息`} status="muted" compact /> : null}</TechnicalDetails> : null}
    </StatusCard> : <StatusCard status="info">
      {dependencyProgress ? <>
        <ProgressRow title="检查依赖关系" state={relationStep} />
        <ProgressRow title="生成执行计划" state={planStep} />
        <ProgressRow title={`${progressAction}所选插件和所需插件`} description={progress.current?.target ? `当前：${progress.current.target}` : undefined} meta={`${elapsedSeconds}s`} state={closureStep} compact={policy.mode === 'compact'} />
        <ProgressRow title="验证完整结果" state={verificationStep} />
      </> : <>
        <ProgressRow title={storeOperation ? '复核精确清理目标' : sourceOperation ? '检查来源操作输入' : configOperation ? '验证设置值' : '检查兼容性'} state={!currentPhase ? 'pending' : preflightActive ? 'active' : 'complete'} />
        <ProgressRow title={progress.current?.phase || (storeOperation ? '安全删除已确认项目' : sourceOperation ? '保存来源配置' : configOperation ? '保存设置层并重新应用' : '连接到所选目标平台')} description={progress.current?.target ? `当前：${progress.current.target}` : undefined} meta={`${elapsedSeconds}s`} state={failedProgress ? 'error' : executionActive ? 'active' : validationActive ? 'complete' : 'pending'} compact={policy.mode === 'compact'} />
        <ProgressRow title="验证结果" state={failedProgress ? 'error' : validationActive ? 'active' : 'pending'} />
      </>}
      {dependencyProgress ? <SectionCard title="执行目标" meta={`${snapshot.progressTargets.length} 个目标`}>{progressTargetOffset > 0 ? <StaticRow title={`↑ 前面还有 ${progressTargetOffset} 个目标`} status="muted" compact /> : null}{visibleProgressTargets.map((entry) => {
        const state = progressLabel(entry);
        const relation = entry.relation === 'requested' ? '你选择的插件' : entry.relation === 'direct' ? '直接依赖' : '间接依赖';
        const title = props.controller.getPluginOverview(entry.pluginId)?.displayName
          ?? entry.pluginId.split('/').at(-1);
        return <ResultRow key={`${entry.pluginId}:${entry.platform}:${entry.scope}`} title={title} description={relation} meta={state.label} status={state.status ?? 'muted'} compact={policy.mode === 'compact'} />;
      })}{hiddenProgressTargets > 0 ? <StaticRow title={`${batchProgress ? '↓ 后面还有' : '另有'} ${hiddenProgressTargets} 个目标`} status="muted" compact /> : null}</SectionCard> : null}
      {!showTechnical && latestMessage && (!dependencyProgress || dependencyMessageLimit > 0) ? <StaticRow title={latestMessage} status="muted" compact /> : null}
      {showTechnical && currentPhase ? <StaticRow title="当前技术阶段" meta={currentPhase} compact /> : null}
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
    const storeOperation = operationKind === 'catalogStorePrune';
    if (storeOperation) breadcrumb = '本地存储 / 结果';
    const taskOperation = operationKind === 'pluginWriteTask';
    const taskSummary = resultSummary?.task;
    const taskBlockedCount = taskSummary?.blockedTargets.length ?? 0;
    const frozenTaskReturnRoute = 'returnRoute' in result
      && result.returnRoute?.name === 'pluginWriteTask'
      ? result.returnRoute : undefined;
    const nestedTaskReturn = frozenTaskReturnRoute !== undefined
      && taskSummary !== undefined
      && frozenTaskReturnRoute.goal !== taskSummary.goal;
    const taskBatchOrigin = frozenTaskReturnRoute?.batchOrigin;
    const remainingTaskTargets = taskSummary?.blockedTargets.map((entry) => entry.target) ?? [];
    const taskReturnRoute: TuiRoute | undefined = nestedTaskReturn
      ? frozenTaskReturnRoute
      : taskSummary && remainingTaskTargets[0] ? {
      name: 'pluginWriteTask',
      pluginId: remainingTaskTargets[0].pluginId,
      goal: taskSummary.goal,
      targetKeys: remainingTaskTargets.map((target) =>
        [target.pluginId, target.platform, target.scope].join('\0')),
      ...(taskBatchOrigin ? { batchOrigin: taskBatchOrigin } : {}),
      ...(taskSummary.goal === 'update' ? {
        versionEvidence: 'returnRoute' in result
          && result.returnRoute?.name === 'pluginWriteTask'
          && result.returnRoute.versionEvidence
          ? result.returnRoute.versionEvidence
          : Object.fromEntries(remainingTaskTargets.flatMap((target) =>
              target.expectedUpdate
                ? [[[target.pluginId, target.platform, target.scope].join('\0'), JSON.stringify({
                    version: target.expectedUpdate.activeVersion,
                    sourceIdentity: target.expectedUpdate.sourceIdentity,
                    binding: target.expectedUpdate.generationKey,
                  })]]
                : [])),
      } : {}),
    } : undefined;
    const batchOperation = operationKind === 'pluginWriteBatch';
    const portableOperation = operationKind === 'portableInstall';
    const portableReceipt = result.state === 'succeeded' || result.state === 'partial'
      ? result.summary.portable : undefined;
    const portableResultScope = portableReceipt?.scope ?? result.portableIntent?.scope;
    const portableResultAgentMode = portableReceipt?.agentMode ?? result.portableIntent?.agentMode;
    const portableInstallFailed = portableReceipt?.failureCode === 'portableSkillsCliInstallFailed';
    const portableOriginIsDetail = 'returnRoute' in result
      && result.returnRoute?.name === 'pluginDetail';
    const portableOriginIsPlatform = 'returnRoute' in result
      && result.returnRoute?.name === 'installTargets';
    const portableReturnLabel = portableOriginIsPlatform ? '返回目标平台'
      : portableOriginIsDetail ? '返回插件详情' : '返回插件列表';
    const configOperation = operationKind === 'configSave' || operationKind === 'configSaveBatch'
      || operationKind === 'configReset'
      ? operationKind : undefined;
    const invalidConfigResult = resultSummary?.configApplySkippedReason === 'invalidConfig';
    const successfulConfigOperation = configOperation !== undefined && !blocked && !partial;
    const sourceOperation = operationKind === 'sourceMutation'
      || operationKind === 'catalogGeneration'
      || operationKind === 'catalogSourcesRecovery';
    const issueOperation = result.originIssue;
    const completedTitle = {
      install: '✓ 插件添加完成',
      refreshAndSync: '✓ 刷新并同步完成',
      reinstall: '✓ 插件重新安装完成',
      uninstall: '✓ 插件移除完成',
      cleanup: '✓ 插件清理完成',
      sync: '✓ 插件同步完成',
    }[action ?? 'install'];
    title = taskOperation
      ? blocked ? `× 插件${pluginWriteTaskLabel(taskSummary?.goal ?? 'restore')}没有完成`
        : partial ? `! 插件${pluginWriteTaskLabel(taskSummary?.goal ?? 'restore')}只完成了一部分`
          : `✓ 插件${pluginWriteTaskLabel(taskSummary?.goal ?? 'restore')}完成`
      : batchOperation
      ? blocked ? '× 批量操作没有完成'
        : partial ? '! 批量操作只完成了一部分' : `✓ 批量${batchActionLabel(action as BatchPluginWriteAction)}完成`
      : portableOperation
      ? blocked ? '× 通用 Skills 安装被阻止'
        : partial ? '! 通用 Skills 结果未完全完成' : '✓ 通用 Skills 已安装'
      : storeOperation
      ? blocked ? '× Catalog 本地存储清理未完成'
        : partial ? '! Catalog 本地存储只完成部分清理' : '✓ Catalog 本地存储清理完成'
      : blocked && result.writeMayHaveCompleted
      ? '× 写入结果未确认'
      : issueOperation
      ? blocked || partial ? '× 问题仍未解决' : '✓ 问题已处理'
      : sourceOperation
      ? blocked ? '× 来源操作未完成'
        : partial ? '! 来源操作只完成了一部分'
        : operationKind === 'catalogSourcesRecovery' ? '✓ Catalog 来源配置已恢复'
          : resultSummary?.catalogAction === 'update'
            ? resultSummary.catalogGeneration?.activeChanged
              && resultSummary.catalogGeneration.outcome === 'activated'
              ? '✓ Catalog 已更新' : '✓ Catalog 无需更新'
            : resultSummary?.catalogAction === 'repair' ? '✓ Catalog 已修复'
              : resultSummary?.catalogAction === 'replaceDamaged' ? '✓ 损坏的 Catalog 已替换'
              : resultSummary?.catalogAction === 'recoverState' ? '✓ Catalog 状态已恢复'
                : operationKind === 'catalogGeneration' ? '✓ Catalog 已启用'
                  : '✓ 来源配置已保存'
      : configOperation
      ? blocked
        ? '× 设置未确认保存'
        : partial ? resultSummary?.configApplySkippedReason === 'invalidConfig'
          ? '! 设置已保存，但未应用'
          : '! 设置已保存，但部分应用失败'
          : resultSummary?.configApplied ? '✓ 设置已保存并应用' : '✓ 设置已保存'
      : partial ? '! 插件操作只完成了一部分'
        : blocked ? result.code === 'operationFailed' ? '× 插件操作没有完成' : '× 插件操作未完成'
          : completedTitle;
    description = taskOperation
      ? blocked ? '任务被安全阻止。已完成和未完成目标按实际结果保留。'
        : partial ? `${taskSummary?.retryTargets?.length ?? 0} 个失败目标可重试 · ${taskBlockedCount} 个目标需要决定。`
          : `${taskSummary?.rootResults.length ?? 0} 个所选插件已处理；下方显示使用位置。`
      : batchOperation
      ? blocked
        ? '批量写入被阻止。已完成和未完成目标按实际结果保留。'
        : partial
          ? (resultSummary?.batch?.retryTargets?.length ?? 0) > 0
            ? `${resultSummary?.batch?.failedRequestedPluginIds.length ?? 0} 个所选插件失败，涉及 ${resultSummary?.batch?.retryTargets?.length ?? 0} 个位置。成功目标不会重放。`
            : '失败目标无法精确定位。请查看本次记录后重新操作。'
          : `${resultSummary?.batch?.requestedPluginIds.length ?? 0} 个所选插件已处理；下方显示使用位置和所需插件。`
      : portableOperation
      ? blocked
        ? result.code === 'operationReviewExpired' || result.code === 'reviewTicketExpired'
          ? '确认信息已过期，写入未开始。请返回修改并重新确认。'
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
        : partial ? resultSummary?.message ?? '来源配置已保存，但 Catalog 尚未启用。可立即重试。'
          : result.sourceAction === 'remove'
            ? '来源记录已移除；已安装插件和插件设置保留。'
            : resultSummary?.message ?? '来源配置已保存。'
      : blocked ? result.message
        : configOperation
          ? partial
            ? resultSummary?.message ?? '设置层已经保存；平台应用失败不会回滚设置。'
            : '设置层已经更新。'
          : '状态已刷新。';
    const pluginId = resultSummary?.pluginId
      ?? ('pluginId' in result ? result.pluginId : undefined);
    const configResultPluginId = pluginId ?? ('returnRoute' in result
      && result.returnRoute
      && 'pluginId' in result.returnRoute
      ? result.returnRoute.pluginId
      : undefined);
    const configRetryScopes = configResultPluginId === undefined ? []
      : operationKind === 'configSaveBatch'
        ? resultSummary?.configGroups?.filter((group) =>
            group.configSaved && group.applyStatus === 'failed'
            && group.errorCode !== 'invalidConfig').map((group) => group.scope) ?? []
        : resultSummary?.configApplyRetryAvailable === true && resultSummary.configScope !== undefined
          ? [resultSummary.configScope] : [];
    const configOrigin = successfulConfigOperation && pluginId
      ? props.controller.configOrigin(pluginId)
      : undefined;
    const dependencyTargets = resultSummary?.targets?.some((target) =>
      target.relation !== undefined && target.relation !== 'requested') ?? false;
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
    const failedPlacement = failedPluginId && failedTarget
      ? props.controller.getPlatformPlacement(failedPluginId, failedTarget.platform)
      : undefined;
    const retryAction = failedPluginId && failedTarget && failedTargetState
      ? selectLifecycleRetryAction({
          operationKind: operationKind === 'catalogSourcesRecovery' || operationKind === 'pluginWriteBatch'
            || operationKind === 'pluginWriteTask' || operationKind === 'configSaveBatch'
            || operationKind === 'catalogStorePrune'
            ? undefined : operationKind,
          originalAction: action,
          target: {
            pluginId: failedPluginId,
            platform: failedTarget.platform,
            scope: failedTarget.scope,
            state: failedTargetState,
            recoveryActions: failedPlacement?.state === 'installed'
              ? failedPlacement.recovery ?? [] : [],
            revision: failedPlacement?.state === 'installed'
              ? failedPlacement.revision : undefined,
          },
        })?.id
      : undefined;
    const retryIssueAction = retryAction
      ? failedIssue?.actions.find((candidate) => (candidate.writeAction === retryAction || candidate.id === retryAction)
        && (candidate.pluginId ?? failedIssue.pluginId) === failedPluginId
        && (candidate.platform ?? failedIssue.platform) === failedTarget?.platform
        && (candidate.scope ?? failedIssue.scope) === failedTarget?.scope)
      : undefined;
    const failedUninstallTargets = action === 'uninstall' && (partial || blocked)
      ? (resultSummary?.targets ?? []).flatMap((target) =>
          target.state === 'failed'
            && target.errorCode !== 'dependencyStillRequired'
            && (target.pluginId ?? pluginId)
            ? [{ pluginId: (target.pluginId ?? pluginId)!, platform: target.platform, scope: target.scope }]
            : [])
      : [];
    const safeCleanupKeys = new Set(
      props.controller.listPluginWriteBatchTargets(
        'cleanup',
        [...new Set(failedUninstallTargets.map((target) => target.pluginId))],
      ).map(batchTargetKey),
    );
    const failedCleanupTargets = failedUninstallTargets.filter((target) =>
      safeCleanupKeys.has(batchTargetKey(target)));
    actions = storeOperation
      ? [
          { label: '返回存储概览', run: () => leaveResult({ name: 'catalogStoreOverview' }) },
          { label: '查看本次记录', run: () => result.operationRecordId
            && go({ name: 'operationDiagnostic', recordId: result.operationRecordId }) },
        ]
      : taskOperation
      ? [
          ...(nestedTaskReturn && taskReturnRoute ? [{
            label: '返回剩余恢复任务',
            description: '保留父任务已选择的位置；返回后重新读取当前状态',
            status: 'success' as const,
            run: () => leaveResult(taskReturnRoute),
          }] : []),
          ...((partial || blocked) && (taskSummary?.retryTargets?.length ?? 0) > 0 ? [{
            label: `继续处理剩余 ${taskSummary!.retryTargets!.length} 项`,
            description: '重新检查失败的精确目标和必要依赖，并进入新的确认页',
            run: () => {
              props.controller.retryFailedPluginWriteTask();
              setFocus(0);
              setScrollOffset(0);
            },
          }] : []),
          ...(taskBlockedCount > 0 && taskReturnRoute ? [{
            label: `返回任务处理 ${taskBlockedCount} 个需决定项`,
            description: '受阻目标没有加入失败重试；返回后可查看原因和可用的下一步',
            status: 'warning' as const,
            run: () => leaveResult(taskReturnRoute),
          }] : []),
          ...(!nestedTaskReturn ? [{ label: '完成，返回我的插件', run: () => {
            if (taskBatchOrigin?.owner === 'batch-write'
              && taskBatchOrigin.flowId === batchDraft?.flowId) {
              setBatchDraft(undefined);
              setDirty(false);
            }
            leaveResult({ name: 'pluginList', mode: 'installed' });
          } }] : []),
          { label: '查看本次记录', run: () => result.operationRecordId
            && go({ name: 'operationDiagnostic', recordId: result.operationRecordId }) },
        ]
      : batchOperation
      ? [
          ...((partial || blocked) && (resultSummary?.batch?.retryTargets?.length ?? 0) > 0 ? [{
            label: '仅重试失败目标',
            description: '重新读取失败根目标及其依赖，并进入新的确认页',
            run: () => {
              props.controller.retryFailedPluginWriteBatch();
              setFocus(0);
              setScrollOffset(0);
            },
          }] : []),
          { label: '返回我的插件', run: () => leaveResult() },
          { label: '查看本次记录', run: () => result.operationRecordId
            && go({ name: 'operationDiagnostic', recordId: result.operationRecordId }) },
        ]
      : portableOperation
      ? blocked || partial ? [
          ...(portableReceipt?.verificationUnknown ? [{
            label: portableRecheckBusy ? '正在重新检查结果…' : '重新检查结果',
            description: portableRecheckBusy
              ? '正在读取 Skills CLI 当前状态；不会执行安装'
              : '只读取 Skills CLI 当前状态，不执行安装',
            disabled: portableRecheckBusy ? '只读检查进行中' : undefined,
            status: 'warning' as const,
            run: async () => {
              if (operationBusy.current) return;
              operationBusy.current = true;
              setPortableRecheckBusy(true);
              try {
                await props.controller.recheckPortableResult();
                setFocus(0);
                setScrollOffset(0);
              } finally {
                operationBusy.current = false;
                setPortableRecheckBusy(false);
              }
            },
          }] : []),
          ...(!portableReceipt?.verificationUnknown
            && (portableReceipt?.missing.length ?? 0) > 0
            && portableReceipt?.missing.every((target) => target.agent) ? [{
              label: '仅重试确认缺失的目标',
              description: '重新准备精确 Skill 与 Agent 组合，并进入新的确认页',
              run: () => { props.controller.startPortableRetryReviewPreparation(); },
            }] : []),
          { label: '返回修改', run: async () => {
            if (!pluginId) {
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
          { label: portableReturnLabel, run: () => { if (pluginId) props.controller.resetPortableFlowToPreview(pluginId); } },
        ] : [
          { label: portableReturnLabel, run: () => {
            props.controller.discardPortableDraft();
            leaveResult();
          } },
          { label: '再安装其他 Skills', run: async () => {
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
            { label: '返回首页', run: () => requestSessionNavigation('home') },
          ]
      : sourceOperation
      ? [{
          label: !blocked && 'returnRoute' in result && result.returnRoute?.name === 'pluginWriteTask'
            ? '重新准备插件更新' : blocked ? '返回修改' : partial ? '现在启用 / 重试' : '查看来源',
          run: () => blocked ? props.controller.resumeResultDraft() : leaveResult(),
        }, { label: '返回首页', run: () => requestSessionNavigation('home') }]
      : configOperation && partial
      ? [
          ...configRetryScopes.map((scope) => ({
            label: configRetryScopes.length > 1 ? `重试应用 · ${scopeLabel(scope)}` : '重试应用',
            description: '先重新显示操作汇总，并重新读取当前状态',
            run: () => beginReview({
              kind: 'configSave',
              pluginId: configResultPluginId!,
              scope,
              apply: true,
              retryApply: true,
              updates: {},
              removeKeys: [],
            }),
          })),
          { label: invalidConfigResult ? '返回设置' : '返回修改', description: '重新打开已保存的设置层', run: () => leaveResult() },
          { label: '返回设置删除字段或重置设置层', description: '显式删除顶层字段或整个设置层', run: () => leaveResult() },
          { label: '保留设置并退出', run: () => requestExit({ code: 1, reason: 'partial' }) },
        ]
      : configOperation && blocked
      ? [
          { label: '返回设置', run: () => props.controller.resumeResultDraft() },
          { label: '返回首页', run: () => requestSessionNavigation('home') },
        ]
      : [{ label: partial || blockedDependencyFailure ? '查看失败项' : successfulConfigOperation && configOrigin
        ? configOrigin.name === 'pluginPreview' ? '返回插件预览'
          : configOrigin.name === 'pluginWriteTask' ? '返回恢复任务' : '返回插件详情'
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
      label: '重试失败部分',
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
    }] : []), { label: '返回首页', run: () => requestSessionNavigation('home') }];
    if (failedCleanupTargets.length > 0) {
      actions.unshift({
        label: '查看清理建议',
        description: `仅处理 ${failedCleanupTargets.length} 个有安全归属证据的失败位置；不使用强制清理`,
        status: 'warning',
        run: () => beginReview(failedCleanupTargets.length === 1 ? {
          kind: 'pluginWrite',
          action: 'cleanup',
          ...failedCleanupTargets[0]!,
        } : {
          kind: 'pluginWriteBatch',
          action: 'cleanup',
          selection: { kind: 'targets', targets: failedCleanupTargets },
          platform: failedCleanupTargets[0]!.platform,
          scope: failedCleanupTargets[0]!.scope,
        }),
      });
    }
    const visibleMessages = resultSummary?.messages?.slice(policy.mode === 'compact' ? -2 : -4) ?? [];
    const visibleChanges = resultSummary?.changes?.slice(0, policy.mode === 'compact' ? 2 : 4) ?? [];
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
    const baseResultPaginationTotal = Math.max(
      resultTargets.length,
      taskSummary?.rootResults.reduce((count, root) =>
        count + 1 + (taskSummary.requestedTargets.filter((target) =>
          target.pluginId === root.pluginId).length), 0) ?? 0,
      (resultSummary?.batch?.rootResults.length ?? 0) + resultTargets.length,
    );
    const resultExtraRows = (resultSummary?.elapsedMs !== undefined ? 1 : 0)
      + visibleMessages.length
      + visibleChanges.length
      + (partial && hasPreservedTarget && resultTargets.some((target) => target.state === 'skipped') ? 1 : 0);
    const portableSelectedSkills = portableReceipt?.selectedSkills
      ?? snapshot.portableResultSkills
      ?? [];
    type PortableResultPair = {
      skill: string;
      agent?: string;
      state: 'verified' | 'missing' | 'unknown';
    };
    const portablePairKey = (pair: Pick<PortableResultPair, 'skill' | 'agent'>): string =>
      `${pair.skill}\0${pair.agent ?? ''}`;
    const portablePairs = new Map<string, PortableResultPair>();
    const addPortablePair = (pair: PortableResultPair): void => {
      const key = portablePairKey(pair);
      const previous = portablePairs.get(key);
      const priority = { verified: 0, missing: 1, unknown: 2 } as const;
      if (!previous || priority[pair.state] >= priority[previous.state]) portablePairs.set(key, pair);
    };
    for (const record of portableReceipt?.verified ?? []) {
      if (record.agents.length === 0) addPortablePair({ skill: record.name, state: 'verified' });
      else for (const agent of record.agents) addPortablePair({ skill: record.name, agent, state: 'verified' });
    }
    for (const target of portableReceipt?.missing ?? []) {
      addPortablePair({ skill: target.skill, ...(target.agent ? { agent: target.agent } : {}), state: 'missing' });
    }
    for (const target of portableReceipt?.unknown ?? []) {
      addPortablePair({ skill: target.skill, ...(target.agent ? { agent: target.agent } : {}), state: 'unknown' });
    }
    if (!(portableReceipt && 'attemptedTargets' in portableReceipt)) {
      for (const skill of portableSelectedSkills) {
        const represented = [...portablePairs.values()].some((pair) => pair.skill === skill);
        if (!represented) addPortablePair({ skill, state: 'unknown' });
      }
    }
    const prioritizedPortablePairs = [...portablePairs.values()].sort((left, right) => {
      const priority = { unknown: 0, missing: 1, verified: 2 } as const;
      return priority[left.state] - priority[right.state]
        || left.skill.localeCompare(right.skill, 'en')
        || (left.agent ?? '').localeCompare(right.agent ?? '', 'en');
    });
    const portableSkillLimit = 1;
    const resultPaginationTotal = result.operationKind === 'portableInstall'
      ? prioritizedPortablePairs.length
      : baseResultPaginationTotal;
    const resultPageRows = result.operationKind === 'portableInstall' ? portableSkillLimit : 1;
    const portableSkillOffset = Math.min(batchTargetOffset,
      Math.max(0, prioritizedPortablePairs.length - 1));
    const visiblePortablePairs = prioritizedPortablePairs.slice(
      portableSkillOffset,
      portableSkillOffset + portableSkillLimit,
    );
    const portableResultRange = prioritizedPortablePairs.length > 0
      ? `第 ${portableSkillOffset + 1}–${portableSkillOffset + visiblePortablePairs.length} 项，共 ${prioritizedPortablePairs.length} 项`
      : undefined;
    const portablePairStateLabel = (pair: PortableResultPair): string =>
      blocked ? result.writeMayHaveCompleted ? '结果未知' : '未执行'
        : pair.state === 'unknown' ? '结果未知'
          : pair.state === 'missing' ? '确认缺失' : '已验证';
    const selectedPortablePair = portableResultDetailOpen
      ? prioritizedPortablePairs.find((pair) =>
          portablePairKey(pair) === portableResultDetailPairKey.current)
      : visiblePortablePairs[0];
    const wrapPortableField = (label: string, value: string): string[] => {
      const chunks = wrapConsoleText(value,
        Math.max(12, size.columns - stringWidth(label) - 14));
      return chunks.map((line, index) => `${label} ${index + 1}/${chunks.length} · ${line}`);
    };
    const portableResultDetailLines = selectedPortablePair ? [
      ...wrapPortableField('Skill', selectedPortablePair.skill),
      ...wrapPortableField('Agent', selectedPortablePair.agent ?? '无法确认'),
      `状态 · ${portablePairStateLabel(selectedPortablePair)}`,
      ...(portableResultScope ? [`范围 · ${scopeLabel(portableResultScope)}`] : []),
      ...(portableReceipt?.recovery
        ? wrapPortableField('安全恢复', portableReceipt.recovery) : []),
      ...(portableReceipt?.failureCode
        ? wrapPortableField('failure code', portableReceipt.failureCode) : []),
      ...(portableReceipt ? [`verification missing · ${portableReceipt.missing.length}`] : []),
      ...(portableReceipt ? wrapPortableField('Skills CLI version', portableReceipt.skillsCliVersion) : []),
      ...(portableReceipt
        ? wrapPortableField('materialization digest', portableReceipt.materializationDigest) : []),
      ...(resultSummary?.elapsedMs !== undefined ? [`elapsed · ${resultSummary.elapsedMs} ms`] : []),
    ] : ['当前结果已变化。请返回结果摘要。'];
    const portableResultDetailPageRows = responsiveBudget(5, 10);
    const safePortableResultDetailOffset = Math.min(
      portableResultDetailOffset,
      Math.max(0, portableResultDetailLines.length - 1),
    );
    const visiblePortableResultDetailLines = portableResultDetailLines.slice(
      safePortableResultDetailOffset,
      safePortableResultDetailOffset + portableResultDetailPageRows,
    );
    if (portableOperation && portableResultDetailOpen) {
      title = '当前结果完整字段';
      description = '按行显示当前 Skill、Agent、状态和技术证据。';
      help = 'p/n 阅读全部字段 · ↑↓ 移动 · Enter 选择 · Esc 返回结果摘要';
      const detailPaginationActions = portableResultDetailLines.length > portableResultDetailPageRows
        ? paginationActions({
            offset: safePortableResultDetailOffset,
            total: portableResultDetailLines.length,
            pageRows: portableResultDetailPageRows,
            move: (direction) => setPortableResultDetailOffset((value) => Math.min(
              Math.max(0, portableResultDetailLines.length - 1),
              Math.max(0, value + direction * portableResultDetailPageRows),
            )),
          })
        : [];
      actions = [
        ...detailPaginationActions,
        { label: '返回结果摘要', run: () => {
          setPortableResultDetailOpen(false);
          setPortableResultDetailOffset(0);
          setFocus(portableResultDetailReturnFocus.current);
          setScrollOffset(0);
        } },
      ];
      portableResultDetailPagination = {
        total: portableResultDetailLines.length,
        pageRows: portableResultDetailPageRows,
      };
    } else if (portableOperation) {
      const detailAction: ActionItem | undefined = selectedPortablePair ? {
        actionId: 'portable-result-full-fields',
        label: '查看当前结果完整字段',
        run: () => {
          portableResultDetailPairKey.current = portablePairKey(selectedPortablePair);
          portableResultDetailReturnFocus.current = focus;
          setPortableResultDetailOpen(true);
          setPortableResultDetailOffset(0);
          setFocus(0);
          setScrollOffset(0);
        },
      } : undefined;
      const pagination = resultPaginationTotal > 1 ? paginationActions({
        offset: batchTargetOffset,
        total: resultPaginationTotal,
        pageRows: resultPageRows,
        move: (direction) => moveBatchTargetPage(resultPaginationTotal, resultPageRows, direction),
      }) : [];
      actions = [
        ...actions.slice(0, 1),
        ...pagination,
        ...(detailAction ? [detailAction] : []),
        ...actions.slice(1),
      ];
      if (pagination.length > 0) {
        referenceDetailPagination = { total: resultPaginationTotal, pageRows: resultPageRows };
      }
    } else if (resultPaginationTotal > 1) {
      actions.push(...paginationActions({
        offset: batchTargetOffset,
        total: resultPaginationTotal,
        pageRows: resultPageRows,
        move: (direction) => moveBatchTargetPage(resultPaginationTotal, resultPageRows, direction),
      }));
      referenceDetailPagination = { total: resultPaginationTotal, pageRows: resultPageRows };
    }
    const portableTechnicalFieldCount = portableReceipt
      ? 3 + (portableReceipt.failureCode ? 1 : 0)
          + (policy.mode === 'compact' ? 0 : resultSummary?.elapsedMs !== undefined ? 1 : 0)
      : 1;
    const portableFixedRows = (portableRecheckBusy ? 1 : 0) + (showTechnical
      ? 1 + portableSkillLimit + 1
        + (portableResultAgentMode === 'automatic' ? 1 : 0)
        + (portableReceipt?.recovery ? 1 : 0)
        + 1 + portableTechnicalFieldCount
      : 3 + portableSkillLimit + 1
        + (portableResultAgentMode === 'automatic' ? 1 : 0)
        + (portableReceipt?.recovery ? 1 : 0));
    currentActionViewportLineBudget = pageActionBudget(portableOperation
      ? portableResultDetailOpen
        ? visiblePortableResultDetailLines.length
          + (safePortableResultDetailOffset > 0 ? 1 : 0)
          + (safePortableResultDetailOffset + visiblePortableResultDetailLines.length
            < portableResultDetailLines.length ? 1 : 0)
        : portableFixedRows
      : resultPaginationTotal > 1 ? 7 : 8);
    const resultActionViewport = actionViewport(actions, true, focus, scrollOffset,
      currentActionViewportLineBudget);
    const resultTargetLimit = Math.max(1, prefixRowLimit(
      prioritizedTargets.map(() => policy.mode === 'compact' ? 1 : 2),
      pageActionBudget() - 3 - resultActionViewport.limit - resultExtraRows,
    ));
    const resultTargetOffset = Math.min(batchTargetOffset, Math.max(0, prioritizedTargets.length - 1));
    const visibleResultTargets = prioritizedTargets.slice(
      resultTargetOffset,
      resultTargetOffset + resultTargetLimit,
    );
    const hiddenResultTargets = Math.max(
      0,
      resultTargets.length - resultTargetOffset - visibleResultTargets.length,
    );
    const portableTechnicalSummary = showTechnical;
    const portableRows = visiblePortablePairs.map((pair) => {
      const status = blocked || pair.state !== 'verified' ? 'warning' as const : 'success' as const;
      const stateLabel = portablePairStateLabel(pair);
      const meta = `${stateLabel} · Agent：${pair.agent ?? '无法确认'}`;
      return <ResultRow
        key={portablePairKey(pair)}
        title={pair.skill}
        meta={meta}
        status={status}
        compact
      />;
    });
    const portableTechnicalRows = portableReceipt
      ? [
            ...(portableReceipt.failureCode
              ? [<StaticRow key="failure-code" title="failure code" meta={portableReceipt.failureCode} compact />]
              : []),
            <StaticRow key="verification-missing" title="verification missing" meta={
              policy.mode === 'compact' && resultSummary?.elapsedMs !== undefined
                ? `${portableReceipt.missing.length} · elapsed ${resultSummary.elapsedMs} ms`
                : String(portableReceipt.missing.length)
            } compact />,
            <StaticRow key="skills-cli-version" title="Skills CLI version" meta={portableReceipt.skillsCliVersion} compact />,
            <StaticRow key="materialization-digest" title="materialization digest" meta={portableReceipt.materializationDigest} compact />,
            ...(policy.mode !== 'compact' && resultSummary?.elapsedMs !== undefined
              ? [<StaticRow key="elapsed" title="elapsed" meta={`${resultSummary.elapsedMs} ms`} compact />]
              : []),
          ]
      : [
          <StaticRow key="failure-code" title="failure code" meta={'code' in result ? result.code : 'operationFailed'} compact />,
        ];
    const resetDispositionText = resultSummary?.resetDisposition === 'absent'
      ? '设置层原本不存在；没有删除内容'
      : resultSummary?.resetDisposition === 'deletedFile'
        ? '已删除设置文件'
        : resultSummary?.resetDisposition === 'unlinkedSymlink'
          ? '已解除设置路径符号链接；链接目标未修改'
          : resultSummary?.resetDisposition === 'quarantinedDirectory'
            ? `设置路径是目录；已隔离为 ${resultSummary.quarantineBasename ?? '安全隔离目录'}`
            : undefined;
    const configGroupRows = resultSummary?.configGroups?.map((group) => {
      const status = !group.configSaved ? 'error' as const
        : group.applyStatus === 'failed' ? 'warning' as const : 'success' as const;
      const outcome = !group.configSaved ? '保存失败'
        : group.applyStatus === 'failed' ? '已保存 · 应用失败'
          : group.applyStatus === 'succeeded' ? '已保存 · 已应用'
            : '已保存';
      return <ResultRow key={`config:${group.scope}`} title={scopeLabel(group.scope)}
        description={group.errorCode} meta={outcome} status={status} compact />;
    }) ?? [];
    const taskRootResults = taskSummary?.rootResults ?? [];
    const blockedTaskTargets = new Map((taskSummary?.blockedTargets ?? []).map((entry) => [
      [entry.target.pluginId, entry.target.platform, entry.target.scope].join('\0'), entry,
    ]));
    const taskRootState = (state: typeof taskRootResults[number]['state']): {
      label: string;
      status: NonNullable<ActionItem['status']>;
    } => {
      if (state === 'completed') return { label: '完成', status: 'success' };
      if (state === 'kept') return { label: '无需更改', status: 'success' };
      if (state === 'partial') return { label: '部分完成', status: 'warning' };
      if (state === 'failed') return { label: '失败', status: 'error' };
      if (state === 'notStarted') return { label: '未开始', status: 'muted' };
      return { label: '待确认', status: 'warning' };
    };
    const taskSelectedPluginRows = taskRootResults.map((root) => {
      const rootState = taskRootState(root.state);
      const rootName = props.controller.getPluginOverview(root.pluginId)?.displayName
        ?? root.pluginId.split('/').at(-1)!;
      const requestedTargets = taskSummary?.requestedTargets.filter((target) =>
        target.pluginId === root.pluginId) ?? [];
      return <ResultRow
        key={`root:${root.pluginId}`}
        title={rootName}
        description={`${requestedTargets.length} 个使用位置`}
        meta={rootState.label}
        status={rootState.status}
        compact
      />;
    });
    const taskLocationRows = taskRootResults.flatMap((root) => {
      const requestedTargets = taskSummary?.requestedTargets.filter((target) =>
        target.pluginId === root.pluginId) ?? [];
      return requestedTargets.map((target) => {
          const key = [target.pluginId, target.platform, target.scope].join('\0');
          const blockedTarget = blockedTaskTargets.get(key);
          const targetResult = root.targets.find((entry) =>
            entry.pluginId === target.pluginId && entry.platform === target.platform
            && entry.scope === target.scope);
          const targetState = blockedTarget ? { label: '待确认', status: 'warning' as const }
            : targetResult?.state === 'completed' ? { label: '完成', status: 'success' as const }
              : targetResult?.state === 'kept' ? { label: '无需更改', status: 'success' as const }
                : targetResult?.state === 'failed' ? { label: '失败', status: 'error' as const }
                  : { label: '未开始', status: 'muted' as const };
          return <ResultRow
            key={`target:${key}`}
            title={`${platformLabel(target.platform)} · ${scopeLabel(target.scope)}`}
            description={blockedTarget
              ? pluginWriteTaskBlockLabel(blockedTarget.reason)
              : targetResult?.errorCode}
            meta={targetState.label}
            status={targetState.status}
            compact={!blockedTarget}
          />;
        });
    });
    const batchResultRows = (resultSummary?.batch?.rootResults ?? []).map((root) => {
      const rootState = taskRootState(root.state);
      const rootName = props.controller.getPluginOverview(root.pluginId)?.displayName
        ?? root.pluginId.split('/').at(-1)!;
      return <ResultRow
        key={`batch-root:${root.pluginId}`}
        title={rootName}
        description={`${root.targets.length} 个使用位置`}
        meta={rootState.label}
        status={rootState.status}
        compact
      />;
    }).concat(prioritizedTargets.map((target) => {
      const state = operationTargetStateLabel(target.state);
      const relation = target.relation === 'requested' ? '你选择的插件'
        : target.relation === 'direct' ? '直接依赖'
          : target.relation === 'transitive' ? '间接依赖' : undefined;
      return <ResultRow
        key={`batch-target:${target.pluginId ?? ''}:${target.platform}:${target.scope}`}
        title={`${resultTargetName(target)} · ${platformLabel(target.platform)} · ${scopeLabel(target.scope)}`}
        description={relation}
        meta={state.label}
        status={state.status ?? 'muted'}
        compact
      />;
    }));
    const taskResultLimit = Math.max(1, pageActionBudget(5) - resultActionViewport.limit);
    const rootResultRows = taskOperation
      ? [...taskSelectedPluginRows, ...taskLocationRows]
      : batchResultRows;
    const taskResultOffset = Math.min(batchTargetOffset, Math.max(0, rootResultRows.length - 1));
    const visibleTaskResultRows = rootResultRows.slice(taskResultOffset, taskResultOffset + taskResultLimit);
    if (taskOperation || batchOperation || resultTargets.length > resultTargetLimit
      || prioritizedPortablePairs.length > portableSkillLimit) {
      help = 'p/n 查看全部项目 · ↑↓ 移动 · Enter 选择 · Esc 返回';
    }
    content = taskOperation || batchOperation ? <Box flexDirection="column">
      <ResultCard status={resultStatus} title="所选插件结果">
        {taskResultOffset > 0 ? <StaticRow title={`↑ 前面还有 ${taskResultOffset} 项`} status="muted" compact /> : null}
        {visibleTaskResultRows}
        {rootResultRows.length > taskResultOffset + visibleTaskResultRows.length
          ? <StaticRow title="↓ 后面还有" meta={`${rootResultRows.length - taskResultOffset - visibleTaskResultRows.length} 项`} status="muted" compact /> : null}
      </ResultCard>
      <SemanticRows actions={actions} focus={focus} kind="action" compact offset={resultActionViewport.offset} limit={resultActionViewport.limit} />
    </Box> : portableOperation ? <Box flexDirection="column">
      {portableRecheckBusy
        ? <ProgressRow title="正在重新检查结果" description="只读取 Skills CLI 当前状态，不执行安装"
            state="active" compact={policy.mode === 'compact'} />
        : null}
      {portableResultDetailOpen ? <>
        {safePortableResultDetailOffset > 0
          ? <StaticRow title={`↑ 前面还有 ${safePortableResultDetailOffset} 行`} status="muted" compact /> : null}
        {visiblePortableResultDetailLines.map((line, index) =>
          <StaticRow key={`${safePortableResultDetailOffset + index}:${line}`} title={line} compact />)}
        {safePortableResultDetailOffset + visiblePortableResultDetailLines.length
          < portableResultDetailLines.length
          ? <StaticRow title={`↓ 后面还有 ${portableResultDetailLines.length
            - safePortableResultDetailOffset - visiblePortableResultDetailLines.length} 行`} status="muted" compact />
          : null}
      </> : portableTechnicalSummary ? <>
        <StaticRow
          title={blocked ? '安装未开始或结果未确认' : partial ? '部分 Skills 未确认' : '通用 Skills 安装结果'}
          meta={portableResultRange}
          status={resultStatus}
          compact
        />
        {portableRows}
        {portableResultScope ? <StaticRow title="范围" meta={scopeLabel(portableResultScope)} compact /> : null}
        {portableResultAgentMode === 'automatic'
          ? <StaticRow title="Agent" meta="Skills CLI 默认选择" compact /> : null}
        {portableReceipt?.recovery ? <StaticRow title={`安全恢复：${portableReceipt.recovery}`} status="warning" compact /> : null}
        <StaticRow title="技术详情" status="muted" compact />
        {portableTechnicalRows}
      </> : <>
      <ResultCard status={resultStatus} title={blocked ? '安装未开始或结果未确认' : partial ? '部分 Skills 未确认' : '通用 Skills 安装结果'}
        meta={portableResultRange}>
      {portableRows}
        {portableResultScope ? <StaticRow title="范围" meta={scopeLabel(portableResultScope)} compact /> : null}
        {portableResultAgentMode === 'automatic'
          ? <StaticRow title="Agent" meta="Skills CLI 默认选择" compact /> : null}
        {portableReceipt?.recovery
          ? <StaticRow title={`安全恢复：${portableReceipt.recovery}`} status="warning" compact />
          : null}
      </ResultCard>
      </>}
      <SemanticRows actions={actions} focus={focus} kind="action" compact offset={resultActionViewport.offset} limit={resultActionViewport.limit} />
    </Box> : <Box flexDirection="column"><ResultCard status={resultStatus} title={blockedDependencyFailure ? '依赖安装没有完成' : blocked ? result.writeMayHaveCompleted ? '结果未确认' : '操作未完成' : sourceOperation ? '来源配置写入已完成' : dependencyTargets ? partial ? '依赖安装没有全部完成' : '操作已完成' : resultSummary?.message ?? '状态已变化，请重新确认'} meta={resultTargets.length > 0 ? `${resultTargets.length} 个目标` : undefined}>{resetDispositionText ? <StaticRow title={resetDispositionText} status="success" compact /> : null}{configGroupRows}{resultTargetOffset > 0 ? <StaticRow title={`↑ 前面还有 ${resultTargetOffset} 个目标`} status="muted" compact /> : null}{visibleResultTargets.map((target) => { const state = operationTargetStateLabel(target.state); const relation = target.relation === 'requested' ? '你选择的插件' : target.relation === 'direct' ? '直接依赖' : target.relation === 'transitive' ? '间接依赖' : undefined; return <ResultRow key={`${target.pluginId ?? ''}:${target.platform}:${target.scope}`} title={resultTargetName(target)} description={relation} meta={state.label} status={state.status ?? 'muted'} compact={policy.mode === 'compact'} />; })}{hiddenResultTargets > 0 ? <StaticRow title="↓ 后面还有" meta={`${hiddenResultTargets} 个目标`} status="muted" compact /> : null}{partial && hasPreservedTarget && resultTargets.some((target) => target.state === 'skipped') ? <StaticRow title="未执行的目标没有写入；已完成或已保留的目标保持可用。" status="muted" compact /> : null}{configOperation && partial && !invalidConfigResult ? <Callout status="warning" title="恢复指引" description="已保存的设置层不会重写。失败的保存层保留草稿；应用失败时只重试应用。" /> : null}{resultSummary?.elapsedMs !== undefined ? <StaticRow title="已用时" meta={`${Math.floor(resultSummary.elapsedMs / 1_000)}s`} /> : null}{visibleMessages.map((message, index) => <StaticRow key={`${index}:${message}`} title={productResultMessage(message)} status="muted" compact />)}</ResultCard><SemanticRows actions={actions} focus={focus} kind="action" compact offset={resultActionViewport.offset} limit={resultActionViewport.limit} /></Box>;
  } else if (route.name === 'pluginContent' && plugin) {
    const overview = props.controller.getPluginContentOverview(plugin.pluginId);
    const contentState = props.controller.getPluginContentState(plugin.pluginId);
    const contentAvailable = overview?.evidence === 'catalogBundle';
    breadcrumb = `${plugin.displayName} / 内容详情`;
    context = contentState === 'loading' ? '正在读取'
      : contentAvailable ? `目录版本 ${overview.pluginVersion}` : '内容不可用';
    title = '内容详情';
    description = contentState === 'loading'
      ? '正在读取这个插件当前目录版本的内容。'
      : contentAvailable
      ? '这里显示已验证目录包声明的组成，不读取或展示完整操作指令。'
      : '当前没有可安全读取的目录内容。';
    const contentNavigationActions: ActionItem[] = [
      { label: '返回插件详情', run: back },
      { label: '查看技术详情', run: () => go({ name: 'pluginTechnical', pluginId: plugin.pluginId }) },
    ];
    const contentTypeLabels = {
      skill: 'Skill', agent: 'Agent', role: '角色', instruction: '指令', permission: '权限',
      hook: 'Hook', command: '命令', mcpServer: 'MCP Server', app: 'App',
    } as const;
    const installedVersions = [...new Set((plugin.update?.targets ?? [])
      .flatMap((target) => target.installedVersion ? [target.installedVersion] : []))];
    const versionDiffers = contentAvailable
      && installedVersions.some((version) => version !== overview.pluginVersion);
    const items = overview?.items ?? [];
    const pageRows = policy.mode === 'compact' ? 1 : responsiveBudget(1, 2);
    const contentOffset = Math.min(batchTargetOffset, Math.max(0, items.length - 1));
    const visibleItems = items.slice(contentOffset, contentOffset + pageRows);
    if (items.length > pageRows) {
      referenceDetailPagination = { total: items.length, pageRows };
      actions = [
        ...paginationActions({
          offset: contentOffset,
          total: items.length,
          pageRows,
          move: (direction) => moveBatchTargetPage(items.length, pageRows, direction),
        }),
        ...contentNavigationActions,
      ];
      context = `${Math.min(contentOffset + 1, items.length)}–${Math.min(contentOffset + visibleItems.length, items.length)} / ${items.length}`;
      help = '↑↓ 操作 · Enter 选择 · p/n 翻页 · Esc 返回';
    } else {
      actions = contentNavigationActions;
    }
    const contentViewport = actionViewport(actions, true, focus, scrollOffset,
      pageActionBudget(Math.min(items.length, pageRows) * 5 + 2));
    content = <Box flexDirection="column">
      {contentAvailable ? <>
        <StaticRow title="版本证据" meta={`插件 ${overview.pluginVersion} · 目录 ${overview.catalogVersion}`} compact />
        <StaticRow
          title={installedVersions.length > 0
            ? `已安装 ${installedVersions.join('、')}`
            : '当前没有已确认的安装版本'}
          description={versionDiffers
            ? '以下是目录版本内容，不代表旧安装版本的内容。'
            : '内容来自当前已验证的目录包。'}
          status={versionDiffers ? 'warning' : 'info'}
          compact
        />
      </> : contentState === 'loading'
        ? <Callout status="info" title="正在读取内容" description="完成后将在当前页面显示。" />
        : <Callout status="warning" title="内容暂不可用" description="可以查看技术详情或恢复插件来源后重试。" />}
      {visibleItems.map((item) => <SectionCard key={item.id} title={item.name} compact>
        <StaticRow title={`${contentTypeLabels[item.type]} · ${item.tools.join('、') || '适用工具待确认'}`} status="muted" compact />
        <StaticRow title={item.description ?? '目录没有提供简短描述'} status={item.description ? 'muted' : 'warning'} compact />
      </SectionCard>)}
      {overview?.notices.map((notice, index) => <StaticRow key={`${index}:${notice}`} title={notice} status="warning" compact />)}
      <SemanticRows actions={actions} focus={focus} kind="action" compact
        offset={contentViewport.offset} limit={contentViewport.limit} />
    </Box>;
  } else if (route.name === 'pluginAbout' && plugin) {
    breadcrumb = `${plugin.displayName} / 关于`;
    title = plugin.displayName;
    description = plugin.description;
    actions = [{ label: '查看技术详情', run: () => go({ name: 'pluginTechnical', pluginId: plugin.pluginId }) }, { label: '查看来源', run: () => go({ name: 'sourceDetail', sourceId: plugin.sourceId }) }];
    content = <Box flexDirection="column"><SectionCard><StaticRow title="版本" meta={plugin.version ?? '未知'} /><StaticRow title="来源" meta={plugin.sourceLabel} /><StaticRow title="可用目标平台" meta={plugin.supportedPlatforms.map(platformLabel).join('、')} /><StaticRow title="配置" meta={`${plugin.configFieldCount} 个字段`} /></SectionCard><SemanticRows actions={actions} focus={focus} kind="action" compact={policy.mode === 'compact'} /></Box>;
  } else if (route.name === 'pluginTechnical' && plugin) {
    breadcrumb = `${plugin.displayName} / 技术详情`;
    context = '只读';
    title = plugin.capabilityUnsupported ? 'Capability 技术详情' : '安装与身份详情';
    description = plugin.capabilityUnsupported
      ? '当前 AW CLI 不支持此插件所需 capability。'
      : '默认页面不会展示这些内部信息。';
    actions = [{ label: '返回插件', run: back }];
    const prioritizedComponents = [...plugin.technicalComponents].sort((left, right) => {
      const priority = (state: typeof left.state): number => state === 'error' ? 0
        : state === 'partial' ? 1 : state === 'absent' ? 2 : 3;
      return priority(left.state) - priority(right.state);
    });
    const detailRowBudget = responsiveBudget(9, 15);
    const capabilityRowCount = plugin.capabilityUnsupported ? 4 : 0;
    const componentRowBudget = Math.max(1,
      detailRowBudget - 4 - plugin.installedPlacements.length - capabilityRowCount);
    const componentLimit = prioritizedComponents.length > componentRowBudget
      ? 1
      : componentRowBudget;
    const componentOffset = Math.min(batchTargetOffset,
      Math.max(0, prioritizedComponents.length - 1));
    const visibleComponents = prioritizedComponents.slice(
      componentOffset,
      componentOffset + componentLimit,
    );
    const hiddenComponents = Math.max(0,
      prioritizedComponents.length - componentOffset - visibleComponents.length);
    if (prioritizedComponents.length > componentLimit) {
      actions.push(...paginationActions({
        offset: componentOffset,
        total: prioritizedComponents.length,
        pageRows: componentLimit,
        move: (direction) => moveBatchTargetPage(prioritizedComponents.length, componentLimit, direction),
      }));
      referenceDetailPagination = { total: prioritizedComponents.length, pageRows: componentLimit };
      help = 'p/n 查看全部组件 · ↑↓ 移动 · Enter 选择 · Esc 返回';
    }
    content = <Box flexDirection="column"><TechnicalDetails><StaticRow title="canonical pluginId" meta={plugin.pluginId} /><StaticRow title="来源" meta={plugin.sourceId} />{plugin.capabilityUnsupported ? <><StaticRow title="failure code" meta="awCapabilityUnsupported" /><StaticRow title="capability 状态" meta="当前 AW CLI 不支持" status="error" /><StaticRow title="缺少 capability" meta={plugin.missingCapabilities?.join('、') ?? 'Status 未提供具体 capability'} /><StaticRow title="恢复方向" meta={plugin.capabilityRecovery ?? '升级 AW CLI 到支持所需 capability 的版本后重试。'} /></> : null}{plugin.installedPlacements.map((placement) => <StaticRow key={placement.platform} title={`${platformLabel(placement.platform)} target`} meta={placementStatus(placement).value} />)}{componentOffset > 0 ? <StaticRow title={`↑ 前面还有 ${componentOffset} 个组件`} status="muted" compact /> : null}{visibleComponents.map((component) => <StaticRow key={`${component.platform}:${component.shared ? 'shared' : component.scope}:${component.key}`} title={`组件 · ${component.state === 'absent' ? '缺失' : component.state}${component.errorCode ? ` · ${component.errorCode}` : ''} · ${component.key} · ${platformLabel(component.platform)} · ${component.shared ? '平台共享' : scopeLabel(component.scope!)}`} />)}{hiddenComponents > 0 ? <StaticRow title={`↓ 后面还有 ${hiddenComponents} 个组件`} status="muted" compact /> : null}</TechnicalDetails><SemanticRows actions={actions} focus={focus} kind="action" compact={policy.mode === 'compact'} /></Box>;
  } else {
    const missingPlugin = definition.entity === 'plugin' && plugin === undefined;
    const missingIssue = definition.entity === 'issue' && issue === undefined;
    const missingConfigField = definition.rendererFamily === 'config'
      && configRoute !== undefined
      && configRoute.name !== 'configFields'
      && configRoute.name !== 'configSave'
      && currentConfigPage !== undefined
      && activeField === undefined;
    let unavailable: 'plugin' | 'issue' | 'config' | 'flow' | undefined;
    switch (route.name) {
      case 'pluginPreview': case 'pluginDependencies': case 'pluginDependencyNode': case 'installPlacement':
      case 'installTargets': case 'uninstallTargets': case 'dependencyPlacement': case 'dependencyPlacementEditor':
      case 'pluginWriteTask': case 'pluginDetail': case 'pluginContent': case 'pluginMore': case 'platform': case 'pluginAbout': case 'pluginTechnical':
      case 'configLayer':
        unavailable = missingPlugin ? 'plugin' : 'flow';
        break;
      case 'portableSkillSelect': case 'portableSkillSummary': case 'portableDependencies': case 'portableAgentMode':
      case 'portableAgentInput': case 'portableScope': case 'portableBlocker':
        unavailable = missingPlugin ? 'plugin' : 'flow';
        break;
      case 'configFields': case 'configSave': case 'configFieldAction':
      case 'configFieldEditor': case 'configObjectPropertyEditor':
        unavailable = missingPlugin ? 'plugin' : missingConfigField ? 'config' : 'flow';
        break;
      case 'issueDetail':
        unavailable = missingIssue ? 'issue' : 'flow';
        break;
      case 'sourceAdd': case 'sourceSave': case 'scriptTimeout':
      case 'batchInstallPlatforms':
      case 'reviewPreparing': case 'review': case 'result':
        unavailable = 'flow';
        break;
      case 'home':
        throw new Error(`TUI renderer invariant failed for ${route.name}`);
      default:
        unreachableTuiRoute(route);
    }
    breadcrumb = unavailable === 'plugin' ? '插件不可用'
      : unavailable === 'issue' ? '问题不可用'
        : unavailable === 'config' ? '设置已变化' : '操作已变化';
    title = unavailable === 'plugin' ? '这个插件已不在当前目录中'
      : unavailable === 'issue' ? '这个问题已经变化'
        : unavailable === 'config' ? '这个设置字段已不再可用' : '这个操作已结束或变化';
    description = '状态已变化。请返回列表并重新选择。';
    actions = [{
      label: unavailable === 'plugin' ? '返回插件列表'
        : unavailable === 'issue' ? '返回问题列表'
          : unavailable === 'config' ? '返回设置列表' : '返回首页',
      run: () => unavailable === 'flow'
        ? requestSessionNavigation('home')
        : go(unavailable === 'plugin'
          ? { name: 'pluginList', mode: 'installed' }
          : unavailable === 'issue' ? { name: 'issueList' }
            : { name: 'configFields', pluginId: configRoute!.pluginId, layer: configRoute!.layer }),
    }];
    content = <SemanticRows actions={actions} focus={focus} kind="action" compact={policy.mode === 'compact'} />;
  }

  if (canOpenHelp && supportsTechnicalDetails) {
    const technicalHelp = route.name === 'progress' ? 'd 技术进度' : 'd 技术详情';
    const remainingHelp = help.split(' · ')
      .filter((item) => item !== '? 帮助' && item !== technicalHelp).join(' · ');
    help = `${technicalHelp} · ? 帮助 · ${remainingHelp}`;
  } else if (canOpenHelp && !help.includes('? 帮助')) {
    help = `? 帮助 · ${help}`;
  }
  if (props.onSessionNavigation && !isCharacterInputMode(route, searchFocus)) {
    help = busy
      ? `${props.pendingSessionNavigation === 'reload' ? '已安排完成后重载'
          : props.pendingSessionNavigation === 'home' ? '已安排完成后回首页'
            : 'h/H 完成后导航'} · Esc 撤销等待 · ${help}`
      : `h 首页 · H 重载 · ${help}`;
  }

  const targetActionSignature = route.name === 'installTargets' && route.view !== 'blocked'
    ? actions.map((action) => String(Boolean(action.disabled))).join(',')
    : '';
  const batchSelectionActionSignature = route.name === 'batchSelection'
    && batchDraft?.stage === 'select'
    ? actions.map((action) => action.pluginId ?? action.label).join('\0')
    : '';
  const portableSelectionActionSignature = route.name === 'portableSkillSelect'
    ? actions.map((action) => action.actionId ?? action.label).join('\0') : '';

  useEffect(() => {
    if (!batchSelectionActionSignature) return;
    const lastActionIndex = Math.max(0, actions.length - 1);
    if (focus > lastActionIndex) {
      setFocus(lastActionIndex);
      setScrollOffset(lastActionIndex);
      return;
    }
    if (scrollOffset > lastActionIndex) setScrollOffset(focus);
  }, [batchSelectionActionSignature, focus, scrollOffset]);

  useEffect(() => {
    if (!portableSelectionActionSignature || focus < actions.length) return;
    setFocus(Math.max(0, actions.length - 1));
    setScrollOffset(0);
  }, [portableSelectionActionSignature, focus, actions.length]);

  useEffect(() => {
    if (!pendingActionFocus.current) return;
    const nextFocus = actions.findIndex((action) => action.actionId === pendingActionFocus.current);
    if (nextFocus < 0) return;
    pendingActionFocus.current = undefined;
    setFocus(nextFocus);
    setScrollOffset(0);
  });

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
        showSafeUiFailure(error, 'tuiActionFailed', 'ui-action');
      });
    } catch (error) {
      showSafeUiFailure(error, 'tuiActionFailed', 'ui-action');
    }
  };

  function requestConfirmedExit(closeModal?: () => void): void {
    closeModal?.();
    const hasDrafts = dirty || props.controller.hasSessionDraft
      || (discardDraftConfirmation?.length ?? 0) > 0;
    setOverlayFocus(0);
    setDiscardForExit(hasDrafts);
    setOverlay(hasDrafts ? 'discard' : 'exit');
  }

  function restoreActionFocus(actionId: string): void {
    pendingActionFocus.current = actionId;
    setFocus(0);
    setScrollOffset(0);
  }

  function requestSessionNavigation(
    navigation: SessionNavigation,
    discardDrafts = false,
  ): void {
    if (!props.onSessionNavigation) {
      if (navigation !== 'home') return;
      if (!props.controller.goHome({ discardDrafts })) {
        setDiscardDraftConfirmation(props.controller.externalDrafts);
        setDiscardForSessionNavigation(navigation);
        setOverlayFocus(0);
        setOverlay('sessionNavigation');
        return;
      }
      resetRootUiState();
      if (discardDrafts) clearExternalDraftValues();
      return;
    }
    const draftConfirmation = discardDrafts ? discardDraftConfirmation : undefined;
    void props.onSessionNavigation(navigation, {
      discardDrafts,
      ...(draftConfirmation ? { draftConfirmation } : {}),
    }).then((result) => {
      if (result === 'draftBlocked') {
        setDiscardDraftConfirmation(props.controller.externalDrafts);
        setDiscardForSessionNavigation(navigation);
        setOverlayFocus(0);
        setOverlay('sessionNavigation');
        return;
      }
      if (result === 'completed') {
        if (navigation === 'home') resetRootUiState();
        if (discardDrafts) clearExternalDraftValues();
        setDiscardDraftConfirmation(undefined);
      }
    }).catch((error: unknown) => showSafeUiFailure(error, 'tuiSessionNavigationFailed', 'session-navigation'));
  }

  function clearExternalDraftValues(): void {
    setDirty(false);
    setConfigDrafts({});
    setConfigCandidate(undefined);
    setObjectDrafts({});
    setChangedObjectDraftKeys([]);
    setObjectError(undefined);
    setSourceDraft(undefined);
    setBatchDraft(undefined);
  }

  function continueEditingFromSessionNavigation(): void {
    if (props.pendingSessionNavigation) props.onCancelPendingSessionNavigation?.();
    setOverlay(undefined);
    setDiscardForSessionNavigation(undefined);
    setDiscardDraftConfirmation(undefined);
  }

  useEffect(() => {
    if (!props.pendingSessionNavigation || !props.pendingSessionNavigationDrafts) return;
    setDiscardForSessionNavigation(props.pendingSessionNavigation);
    setDiscardDraftConfirmation(props.pendingSessionNavigationDrafts);
    setOverlayFocus(0);
    setOverlay('sessionNavigation');
  }, [props.pendingSessionNavigation, props.pendingSessionNavigationDrafts]);

  const normalizedEffectiveFocus = route.name === 'batchSelection' && batchDraft?.stage === 'select'
    ? Math.min(effectiveFocus, Math.max(0, actions.length - 1))
    : effectiveFocus;
  useInput((input, key) => {
    if (!overlay && route.name === 'reviewPreparing' && snapshot.reviewPreparation?.state === 'failed'
      && (key.escape || input.toLowerCase() === 'b')) {
      back();
      return;
    }
    if (preparationRunning) {
      const sessionNavigation = resolveTuiSessionNavigationKey(
        { input, key },
        { characterInput: false },
      );
      if (sessionNavigation) {
        requestSessionNavigation(sessionNavigation);
      } else if (key.escape || input.toLowerCase() === 'b') {
        back();
      } else if (input.toLowerCase() === 'q' || (key.ctrl && input.toLowerCase() === 'c')) {
        setExitAfterPreparation(true);
      }
      return;
    }
    if (busy) {
      const sessionNavigation = resolveTuiSessionNavigationKey(
        { input, key },
        { characterInput: false },
      );
      if ((key.pageUp || key.pageDown) && route.name === 'progress') {
        const total = snapshot.progressTargets.length;
        const pageRows = 1;
        setBatchTargetOffset((value) => Math.min(
          Math.max(0, total - 1),
          Math.max(0, value + (key.pageUp ? -pageRows : pageRows)),
        ));
      } else if (overlay === 'help') {
        if (key.escape || key.return || input.toLowerCase() === 'b' || input === '?') {
          setOverlay(undefined);
        } else if (input.toLowerCase() === 'q' || (key.ctrl && input.toLowerCase() === 'c')) {
          setExitAfterBusy(true);
        } else if (sessionNavigation) {
          setOverlay(undefined);
          requestSessionNavigation(sessionNavigation);
        }
      } else if (key.escape && props.pendingSessionNavigation) {
        props.onCancelPendingSessionNavigation?.();
      } else if (sessionNavigation) {
        requestSessionNavigation(sessionNavigation);
      } else if (input.toLowerCase() === 'q' || (key.ctrl && input.toLowerCase() === 'c')) {
        setExitAfterBusy(true);
      } else if (canOpenHelp && input === '?') {
        setOverlayFocus(0);
        setOverlay('help');
      } else if (!tooSmall && supportsTechnicalDetails && input.toLowerCase() === 'd') {
        toggleTechnical();
      }
      return;
    }
    if (tooSmall && !overlay) {
      if (input.toLowerCase() === 'q' || (key.ctrl && input.toLowerCase() === 'c')) {
        setOperationConfirmation(undefined);
        setSourceTransportOverlay(undefined);
        requestConfirmedExit();
      }
      return;
    }
    if (portableEmptySelectionOpen) {
      const closeEmptySelection = (): void => setPortableEmptySelectionOpen(false);
      if (key.escape || key.return || input.toLowerCase() === 'b') {
        closeEmptySelection();
      } else if (input.toLowerCase() === 'q' || (key.ctrl && input.toLowerCase() === 'c')) {
        requestConfirmedExit(closeEmptySelection);
      }
      return;
    }
    if (projectReminderOpen) {
      const closeProjectReminder = (): void => {
        setProjectReminderOpen(false);
        setOverlayFocus(0);
      };
      if (key.escape || input.toLowerCase() === 'b') {
        closeProjectReminder();
      } else if (input.toLowerCase() === 'q' || (key.ctrl && input.toLowerCase() === 'c')) {
        requestConfirmedExit(closeProjectReminder);
      } else if (props.onSessionNavigation && (input === 'h' || input === 'H')) {
        closeProjectReminder();
        requestSessionNavigation(input === 'H' ? 'reload' : 'home');
      } else if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) {
        setOverlayFocus((value) => {
          if ((snapshot.projectIntentReminder?.actionableTargets.length ?? 0) > 0) {
            return moveIndex(3, value, key.upArrow || key.leftArrow ? -1 : 1);
          }
          return value === 0 ? 2 : 0;
        });
      } else if (key.return) {
        const reminder = snapshot.projectIntentReminder;
        closeProjectReminder();
        if (!reminder || overlayFocus === 0) return;
        if (overlayFocus === 1 && reminder.actionableTargets.length > 0) {
          prepareCurrentProjectTargets(reminder.actionableTargets);
        } else {
          go({ name: 'projectStatus' });
        }
      }
      return;
    }
    if (operationConfirmation) {
      const activeReview = snapshot.activeReview;
      const closeConfirmation = (): void => {
        setOperationConfirmation(undefined);
        setFocus(operationConfirmation.returnFocus);
        setScrollOffset(operationConfirmation.returnScrollOffset);
        setOverlayFocus(0);
      };
      if (key.escape || input.toLowerCase() === 'b') {
        closeConfirmation();
      } else if (input.toLowerCase() === 'q' || (key.ctrl && input.toLowerCase() === 'c')) {
        requestConfirmedExit(closeConfirmation);
      } else if (props.onSessionNavigation && (input === 'h' || input === 'H')) {
        const navigation = input === 'H' ? 'reload' : 'home';
        closeConfirmation();
        requestSessionNavigation(navigation);
      } else if ((key.pageUp || key.pageDown
        || input.toLowerCase() === 'p' || input.toLowerCase() === 'n')
        && confirmationPagination) {
        const warningCount = confirmationPagination.total;
        const warningLimit = confirmationPagination.pageRows;
        setOperationConfirmation((current) => current ? {
          ...current,
          warningOffset: Math.min(Math.max(0, warningCount - 1),
            Math.max(0, current.warningOffset
              + (key.pageUp || input.toLowerCase() === 'p' ? -warningLimit : warningLimit))),
        } : current);
      } else if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) {
        setOverlayFocus((value) => moveIndex(confirmationPagination ? 4 : 2,
          value, key.upArrow || key.leftArrow ? -1 : 1));
      } else if (key.return) {
        if (overlayFocus === 0) {
          closeConfirmation();
        } else if (confirmationPagination && (overlayFocus === 2 || overlayFocus === 3)) {
          const direction = overlayFocus === 2 ? -1 : 1;
          setOperationConfirmation((current) => current ? {
            ...current,
            warningOffset: Math.min(
              Math.max(0, confirmationPagination!.total - 1),
              Math.max(0, current.warningOffset + direction * confirmationPagination!.pageRows),
            ),
          } : current);
        } else if (activeReview?.reviewToken !== operationConfirmation.reviewToken) {
          closeConfirmation();
          setActionError('确认内容已变化。请重新检查操作汇总。');
        } else if (!operationBusy.current) {
          operationBusy.current = true;
          setOperationConfirmation(undefined);
          void props.controller.executeOperation(operationConfirmation.reviewToken).then(() => {
            setFocus(0);
            setScrollOffset(0);
          }).finally(() => {
            operationBusy.current = false;
          });
        }
      }
      return;
    }
    if (sourceTransportOverlay) {
      const closeTransportOverlay = (): void => {
        setSourceTransportOverlay(undefined);
        setOverlayFocus(0);
      };
      if (key.escape || input.toLowerCase() === 'b') {
        closeTransportOverlay();
      } else if (input.toLowerCase() === 'q' || (key.ctrl && input.toLowerCase() === 'c')) {
        requestConfirmedExit(closeTransportOverlay);
      } else if (props.onSessionNavigation && (input === 'h' || input === 'H')) {
        closeTransportOverlay();
        requestSessionNavigation(input === 'H' ? 'reload' : 'home');
      } else if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) {
        setOverlayFocus((value) => moveIndex(2, value, key.upArrow || key.leftArrow ? -1 : 1));
      } else if (key.return && route.name === 'sourceEdit') {
        const configured = props.controller.getConfiguredSource(route.sourceId);
        const current = sourceDraft?.owner === sourceTransportOverlay.owner
          ? sourceDraft
          : configured ? sourceDraftFromSource(configured, sourceTransportOverlay.owner) : undefined;
        const location = overlayFocus === 0
          ? OFFICIAL_CATALOG_SOURCE_URL : OFFICIAL_CATALOG_SOURCE_SSH_URL;
        if (current && current.type === 'git' && current.location !== location) {
          setSourceDraft({ ...current, location });
          setDirty(true);
          props.controller.replace({ name: 'sourceEdit', sourceId: route.sourceId, owner: current.owner });
        }
        closeTransportOverlay();
      }
      return;
    }
    if (pluginListChooser) {
      const sourceIds = ['all', ...props.controller.listSources().map((source) => source.id)];
      const itemCount = pluginListChooser.kind === 'source' ? sourceIds.length : PLUGIN_FILTERS.length;
      if (key.escape) {
        setPluginListChooser(undefined);
      } else if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) {
        const direction = key.upArrow || key.leftArrow ? -1 : 1;
        setPluginListChooser((current) => current ? {
          ...current,
          focus: moveIndex(itemCount, current.focus, direction),
        } : current);
      } else if (key.return) {
        const selectedIndex = Math.min(pluginListChooser.focus, Math.max(0, itemCount - 1));
        if (pluginListChooser.kind === 'source') {
          const selectedSourceId = sourceIds[selectedIndex];
          if (selectedSourceId) choosePluginListSource?.(selectedSourceId);
        } else {
          const selectedFilter = PLUGIN_FILTERS[selectedIndex];
          if (selectedFilter) choosePluginListFilter?.(selectedFilter);
        }
        setPluginListChooser(undefined);
      }
      return;
    }
    if (overlay) {
      if (input.toLowerCase() === 'q' || (key.ctrl && input.toLowerCase() === 'c')) {
        if (overlay === 'sessionNavigation') continueEditingFromSessionNavigation();
        setDiscardForSessionNavigation(undefined);
        setDiscardDraftConfirmation(undefined);
        requestConfirmedExit(overlay === 'help' ? () => setOverlay(undefined) : undefined);
        return;
      }
      if (overlay === 'help' && props.onSessionNavigation && (input === 'h' || input === 'H')) {
        setOverlay(undefined);
        requestSessionNavigation(input === 'H' ? 'reload' : 'home');
        return;
      }
      if (overlay === 'help' && input.toLowerCase() === 'o') {
        setOverlay(undefined);
        go({ name: 'operationHistory' });
        return;
      }
      if (key.escape || input.toLowerCase() === 'b' || input === '?') {
        if (overlay === 'sessionNavigation') {
          continueEditingFromSessionNavigation();
        } else setOverlay(undefined);
        return;
      }
      if (key.leftArrow || key.rightArrow || key.upArrow || key.downArrow) {
        const count = overlay === 'help' && props.onSessionNavigation ? 3 : overlay === 'help' ? 1 : 2;
        const direction = key.leftArrow || key.upArrow ? -1 : 1;
        setOverlayFocus((value) => moveIndex(count, value, direction));
        return;
      }
      if (key.return) {
        if (overlay === 'help') {
          setOverlay(undefined);
          if (props.onSessionNavigation && overlayFocus === 1) requestSessionNavigation('home');
          else if (props.onSessionNavigation && overlayFocus === 2) requestSessionNavigation('reload');
        } else if (overlayFocus === 0) {
          if (overlay === 'sessionNavigation') continueEditingFromSessionNavigation();
          else setOverlay(undefined);
        }
        else if (overlay === 'discard') {
          setOverlay(undefined);
          setDirty(false);
          setConfigDrafts({});
          setConfigCandidate(undefined);
          setObjectDrafts({});
          setChangedObjectDraftKeys([]);
          const discardedSourceDraft = sourceDraft;
          setSourceDraft(undefined);
          setBatchDraft(undefined);
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
        } else if (overlay === 'sessionNavigation' && discardForSessionNavigation) {
          const navigation = discardForSessionNavigation;
          setOverlay(undefined);
          setDiscardForSessionNavigation(undefined);
          requestSessionNavigation(navigation, true);
        } else requestExit({ code: snapshot.phase === 'error' ? 1 : 0, reason: snapshot.phase === 'error' ? 'initialError' : 'user' });
      }
      return;
    }
    if (key.ctrl && input.toLowerCase() === 'c') {
      requestConfirmedExit();
      return;
    }
    if (route.name === 'operationReportPreview' && reportSaveMode) {
      if (key.escape) {
        setReportSaveMode(false);
        setReportSaveError(undefined);
        return;
      }
      if (key.return) {
        const savePath = reportSavePath.trim();
        if (!savePath) {
          setReportSaveError('请输入要保存到的本地文件路径。');
          return;
        }
        void props.controller.saveOperationReport(route.recordId, savePath).then(() => {
          setReportSaveMode(false);
          setReportSaveResult('报告已保存到你选择的位置。');
          setReportSaveError(undefined);
        }).catch(() => {
          setReportSaveMode(false);
          setReportSaveError('报告未保存。请检查保存位置后重试。');
        });
        return;
      }
      if (input === '\u0015' || (input.toLowerCase() === 'u' && key.ctrl)) {
        setReportSavePath('');
        setReportSaveError(undefined);
        return;
      }
      if (key.backspace || key.delete) setReportSavePath(removeLastGrapheme);
      else if (input && !key.ctrl && !key.meta && input >= ' ') setReportSavePath((value) => value + input);
      setReportSaveError(undefined);
      return;
    }
    if ((key.pageUp || key.pageDown || input.toLowerCase() === 'p' || input.toLowerCase() === 'n')
      && route.name === 'result' && portableResultDetailOpen
      && portableResultDetailPagination) {
      const { total, pageRows } = portableResultDetailPagination;
      const direction = key.pageUp || input.toLowerCase() === 'p' ? -1 : 1;
      setPortableResultDetailOffset((value) => Math.min(
        Math.max(0, total - 1),
        Math.max(0, value + direction * pageRows),
      ));
      return;
    }
    if ((key.pageUp || key.pageDown || input.toLowerCase() === 'p' || input.toLowerCase() === 'n')
      && (route.name === 'pluginContent'
        || route.name === 'pluginTechnical'
        || route.name === 'projectStatus' && showTechnical
        || route.name === 'issueDetail' && showTechnical
        || route.name === 'sourceRemoveBlocked' && sourceDependenciesExpanded
        || route.name === 'pluginDependencies' && route.view === 'removeBlocked' && !showTechnical
        || route.name === 'pluginDependencyNode'
          && (route.view === 'references' || route.view === 'details')
        || route.name === 'pluginDetail'
        || route.name === 'configSave' && route.view === 'changes'
        || route.name === 'sourceSave' && route.view === 'changes'
        || route.name === 'review'
        || route.name === 'result')
      && referenceDetailPagination) {
      const { total, pageRows } = referenceDetailPagination;
      moveBatchTargetPage(total, pageRows,
        key.pageUp || input.toLowerCase() === 'p' ? -1 : 1);
      return;
    }
    if ((key.pageUp || key.pageDown)
      && route.name === 'pluginWriteTask') {
      const total = props.controller.listPluginWriteTaskCandidates(route.goal)
        .filter((candidate) => candidate.target.pluginId === route.pluginId
          && (!route.targetKeys || route.targetKeys.includes(pluginWriteTaskTargetKey(candidate)))).length;
      setBatchTargetOffset((value) => Math.min(
        Math.max(0, total - 1),
        Math.max(0, value + (key.pageUp ? -1 : 1)),
      ));
      return;
    }
    if ((key.pageUp || key.pageDown) && route.name === 'pluginTechnical' && plugin) {
      const total = plugin.technicalComponents.length;
      const pageRows = 1;
      setBatchTargetOffset((value) => Math.min(
        Math.max(0, total - 1),
        Math.max(0, value + (key.pageUp ? -pageRows : pageRows)),
      ));
      return;
    }
    if ((key.pageUp || key.pageDown) && route.name === 'issueDetail' && issue && showTechnical) {
      const total = diagnosticDetailRowCount(issue.diagnostic);
      const pageRows = responsiveBudget(5, 10);
      setBatchTargetOffset((value) => Math.min(
        Math.max(0, total - pageRows),
        Math.max(0, value + (key.pageUp ? -pageRows : pageRows)),
      ));
      return;
    }
    if ((key.pageUp || key.pageDown || input.toLowerCase() === 'p' || input.toLowerCase() === 'n')
      && route.name === 'sourceTechnical') {
      const total = diagnosticDetailLines(resolveSourceTechnicalDiagnostic(route.sourceId), size.columns - 6).length;
      setBatchTargetOffset((value) => Math.min(
        Math.max(0, total - sourceTechnicalPageRows),
        Math.max(0, value + (key.pageUp || input.toLowerCase() === 'p'
          ? -sourceTechnicalPageRows : sourceTechnicalPageRows)),
      ));
      return;
    }
    if ((key.pageUp || key.pageDown) && route.name === 'sourceRemoveBlocked'
      && sourceDependenciesExpanded) {
      const total = sourceReferenceSummary?.dependencies.length ?? 0;
      const pageRows = Math.max(1, pageActionBudget(10));
      setBatchTargetOffset((value) => Math.min(
        Math.max(0, total - pageRows),
        Math.max(0, value + (key.pageUp ? -pageRows : pageRows)),
      ));
      return;
    }
    if ((key.pageUp || key.pageDown) && route.name === 'pluginDependencies' && plugin) {
      const overview = dependencyOverview(plugin);
      const dependents = route.view === 'removeBlocked' && route.platform && route.scope
        ? props.controller.getBlockingDependents(plugin.pluginId, route.platform, route.scope)
        : overview?.dependents ?? [];
      const total = route.view === 'removeBlocked'
        ? dependents.length
        : (overview?.blockers.length ?? 0) + (overview?.dependencies.length ?? 0) + dependents.length;
      const pageRows = 1;
      setBatchTargetOffset((value) => Math.min(
        Math.max(0, total - pageRows),
        Math.max(0, value + (key.pageUp ? -pageRows : pageRows)),
      ));
      return;
    }
    if ((route.name === 'operationDiagnostic' || route.name === 'operationReportPreview')
      && (key.pageUp || key.pageDown || input.toLowerCase() === 'p' || input.toLowerCase() === 'n')) {
      const detail = route.name === 'operationDiagnostic'
        ? props.controller.getOperationDiagnostic(route.recordId) : undefined;
      const preview = route.name === 'operationReportPreview'
        ? props.controller.previewOperationReport(route.recordId) : undefined;
      const total = detail ? operationDiagnosticLineCount(detail)
        : preview ? operationReportLineCount(preview) : 0;
      const visibleRows = 2;
      const pageRows = key.pageUp || key.pageDown
        ? policy.mode === 'compact' ? 2 : Math.max(1, pageActionBudget(5))
        : visibleRows;
      setScrollOffset((value) => Math.min(
        Math.max(0, total - pageRows),
        Math.max(0, value + (key.pageUp || input.toLowerCase() === 'p' ? -pageRows : pageRows)),
      ));
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
      if (input === '\u0015' || (input.toLowerCase() === 'u' && key.ctrl)) {
        setPortableAgentInput('');
        setInputError(undefined);
        return;
      }
      if (key.backspace || key.delete) setPortableAgentInput(removeLastGrapheme);
      else if (input && !key.ctrl && !key.meta && input >= ' ') setPortableAgentInput((value) => value + input);
      setInputError(undefined);
      return;
    }
    if (route.name === 'scriptTimeout') {
      if (key.escape) {
        const intent = pendingReviewIntentRef.current;
        back();
        if (intent) beginReview(intent);
        return;
      }
      const pendingIntent = pendingReviewIntentRef.current;
      if (key.return && pendingIntent) {
        try {
          const scriptTimeoutMs = parseScriptTimeoutMs(scriptTimeoutInput);
          const intent = { ...pendingIntent, scriptTimeoutMs } as OperationIntent;
          setScriptTimeoutError(undefined);
          back();
          beginReview(intent);
        } catch (error) {
          setScriptTimeoutError(error instanceof Error ? error.message : '脚本超时无效。');
        }
        return;
      }
      if (input === '\u0015' || (input.toLowerCase() === 'u' && key.ctrl)) setScriptTimeoutInput('');
      else if (key.backspace || key.delete) setScriptTimeoutInput(removeLastGrapheme);
      else if (input && !key.ctrl && !key.meta && input >= ' ') setScriptTimeoutInput((value) => value + input);
      setScriptTimeoutError(undefined);
      return;
    }
    if (route.name === 'sourceAdd'
      && route.step !== 'type'
      && route.step !== 'refPolicy'
      && sourceDraft?.owner === route.owner) {
      if (key.escape) {
        back();
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
          if (sourceInput.trim() === '' || sourceInput !== sourceInput.trim() || /[\s\u0000-\u001f\u007f]/u.test(sourceInput)) error = '请输入分支名、标签或提交标识，不含空白或控制字符。';
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
        else if (route.step === 'ref') {
          next.refPolicy = 'explicit';
          next.ref = sourceInput;
        }
        else next.subdir = sourceInput === '' ? '' : path.posix.normalize(sourceInput).replace(/^\.\//u, '').replace(/\/$/u, '');
        setSourceDraft(next);
        setDirty(true);
        setSourceInputError(undefined);
        if (route.returnToDraft) acceptSourceFieldAndBack();
        else if (route.step === 'id') go({ name: 'sourceAdd', step: 'location', owner: route.owner });
        else if (route.step === 'location') {
          if (next.type === 'git') go({ name: 'sourceAdd', step: 'refPolicy', owner: route.owner });
          else go({ name: 'sourceEdit', sourceId: next.sourceId, owner: route.owner });
        } else if (route.step === 'ref') {
          go({ name: 'sourceAdd', step: 'subdir', owner: route.owner });
        } else go({ name: 'sourceEdit', sourceId: next.sourceId, owner: route.owner });
        return;
      }
      if (input === '\u0015' || (input.toLowerCase() === 'u' && key.ctrl)) setSourceInput('');
      else if (key.backspace || key.delete) setSourceInput(removeLastGrapheme);
      else if (input && !key.ctrl && !key.meta && input >= ' ') setSourceInput((value) => value + input);
      setSourceInputError(undefined);
      return;
    }
    if (route.name === 'configFieldEditor'
      && (route.editor === 'string' || route.editor === 'number')
      && ((activeField?.choices?.length ?? 0) === 0 || route.mode === 'custom')) {
      if (key.escape) {
        setConfigCandidate(undefined);
        back();
        return;
      }
      if (input === '\u0015' || (input.toLowerCase() === 'u' && key.ctrl)) {
        setInputValue('');
        setInputError(undefined);
        return;
      }
      if (key.return && activeField) {
        if (activeField.sensitive && inputValue.length === 0) {
          back();
          return;
        }
        let candidate: PluginConfigScalar = inputValue;
        if (route.editor === 'number') {
          candidate = Number(inputValue);
        }
        const issues = validatePluginConfigValue(activeField.definition, candidate, activeField.key);
        if (issues.length > 0) {
          setInputError(issues.slice(0, 2).map(objectIssueText).join('；'));
          return;
        }
        updateDraft(activeField.key, candidate);
        return;
      }
      if (input === '\u0015' || (input.toLowerCase() === 'u' && key.ctrl)) setInputValue('');
      else if (key.backspace || key.delete) setInputValue(removeLastGrapheme);
      else if (input && !key.ctrl && !key.meta && input >= ' ') setInputValue((value) => value + input);
      setInputError(undefined);
      return;
    }
    if (route.name === 'configObjectPropertyEditor'
      && (route.stage === 'key' || route.stage === 'custom')
      && activeField?.definition.type === 'object'
      && activeObjectDraft) {
      if (key.escape) {
        back();
        return;
      }
      if (input === '\u0015' || (input.toLowerCase() === 'u' && key.ctrl)) {
        setInputValue('');
        setInputError(undefined);
        return;
      }
      if (key.return && route.stage === 'key') {
        const propertyKey = inputValue;
        if (Object.hasOwn(activeObjectDraft, propertyKey)
          || Object.hasOwn(activeField.definition.properties ?? {}, propertyKey)) {
          setInputError('这个键已存在。');
          return;
        }
        const keyIssues = activeField.definition.validation?.key
            ? validatePluginConfigValue({
              type: 'object',
              additionalProperties: { type: 'string' },
              validation: { key: activeField.definition.validation.key },
            }, { [propertyKey]: 'value' }, activeField.key)
          : [];
        const definition = activeField.definition.additionalProperties;
        if (!definition) {
          setInputError('这个设置不支持新增项目。');
          return;
        }
        const countIssues = validatePluginConfigValue(
          activeField.definition,
          { ...activeObjectDraft, [propertyKey]: definition.type === 'number'
            ? 0
            : definition.type === 'boolean' ? false : '' },
          activeField.key,
        ).filter((issue) => issue.code === 'maxProperties');
        const issues = [...keyIssues, ...countIssues];
        if (issues.length > 0) {
          setInputError(issues.slice(0, 2).map(objectIssueText).join('；'));
          return;
        }
        props.controller.replace({
          ...route,
          propertyKey,
          stage: objectPropertyStage(definition),
        });
        setFocus(0);
        return;
      }
      if (key.return && route.stage === 'custom'
        && route.propertyKey !== undefined && activePropertyDefinition) {
        if (activePropertySensitive && inputValue.length === 0) {
          back();
          return;
        }
        const candidate: PluginConfigScalar = activePropertyDefinition.type === 'number'
          ? Number(inputValue)
          : inputValue;
        if (updateObjectProperty(route.propertyKey, candidate)) back();
        return;
      }
      if (key.backspace || key.delete) setInputValue(removeLastGrapheme);
      else if (input && !key.ctrl && !key.meta && input >= ' ') setInputValue((value) => value + input);
      setInputError(undefined);
      return;
    }
    if (searchFocus && (route.name === 'pluginList' || route.name === 'batchSelection')) {
      if (key.escape) {
        setSearchFocus(false);
        return;
      }
      if (key.return) {
        setSearchFocus(false);
        if (route.name === 'pluginList') {
          const row = pluginRows[focus];
          if (row?.menuAction) row.menuAction();
          else if (row) go({ name: 'pluginDetail', pluginId: row.pluginId });
        }
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
        const current = route.name === 'pluginList' ? route.sourceId ?? 'all' : batchDraft?.sourceId ?? 'all';
        const direction = key.leftArrow ? -1 : 1;
        const next = tabs[(tabs.indexOf(current) + direction + tabs.length) % tabs.length]!;
        if (route.name === 'pluginList') {
          props.controller.replace(
            { name: 'pluginList', mode: route.mode, ...(next !== 'all' ? { sourceId: next } : {}) },
            { ...snapshot.router.current.context, query, installFilter, sourceTabId: next },
          );
        } else {
          setBatchDraft((draft) => draft ? {
            ...draft,
            ...(next === 'all' ? { sourceId: undefined } : { sourceId: next }),
            showSelected: false,
          } : draft);
        }
        setFocus(0);
        setScrollOffset(0);
        return;
      }
      if (route.name === 'pluginList') {
        const nextQuery = input === '\u0015' || (input.toLowerCase() === 'u' && key.ctrl)
          ? ''
          : key.backspace || key.delete
            ? removeLastGrapheme(query)
            : input && !key.ctrl && !key.meta && input >= ' '
              ? query + input : query;
        setQuery(nextQuery);
        const matchingItems = props.controller.listPlugins({
          mode: route.mode,
          ...(route.sourceId ? { sourceId: route.sourceId } : {}),
          ...(nextQuery ? { query: nextQuery } : {}),
          installFilter,
        });
        const matchingRows = pluginListRowIds(route.mode, matchingItems, nextQuery);
        setFocus(matchingItems[0] ? matchingRows.indexOf(matchingItems[0].pluginId) : 0);
      } else {
        setBatchDraft((draft) => draft ? {
          ...draft,
          query: input === '\u0015' || (input.toLowerCase() === 'u' && key.ctrl)
            ? ''
            : key.backspace || key.delete
              ? removeLastGrapheme(draft.query)
              : input && !key.ctrl && !key.meta && input >= ' '
                ? draft.query + input : draft.query,
          showSelected: false,
        } : draft);
      }
      if (route.name === 'batchSelection') setFocus(0);
      setScrollOffset(0);
      return;
    }
    if (route.name === 'configFields' && configGroupChooserOpen) {
      if (key.escape || input.toLowerCase() === 'b') {
        setConfigGroupChooserOpen(false);
        setFocusZone('actions');
        setPinnedActionFocus(1);
      } else if (key.upArrow || key.downArrow) {
        setConfigGroupChoiceFocus((value) => moveIndex(
          visibleConfigTabs.length,
          value,
          key.upArrow ? -1 : 1,
        ));
      } else if (key.return) {
        const selected = visibleConfigTabs[configGroupChoiceFocus];
        if (selected) {
          props.controller.updatePageContext({
            configGroupId: selected.id,
            focusIndex: 0,
            scrollOffset: 0,
          });
          setConfigGroupChooserOpen(false);
          setFocusZone('content');
          setFocus(0);
          setScrollOffset(0);
        }
      }
      return;
    }
    if ((route.name === 'pluginList' || route.name === 'sourceList' || route.name === 'projectStatus'
      || route.name === 'batchInstallPlatforms' || route.name === 'batchInstallScope'
      || route.name === 'batchPlacement' && pinnedActions.length > 0
      || route.name === 'portableSkillSelect'
      || route.name === 'batchSelection' && batchDraft?.stage === 'select'
      || route.name === 'installTargets' && route.view !== 'blocked') && key.tab) {
      setFocusZone((current) => current === 'content' ? 'actions' : 'content');
      return;
    }
    if (route.name === 'configFields' && key.tab) {
      setFocusZone((current) => current === 'content' ? 'actions' : 'content');
      return;
    }
    if (route.name === 'pluginList' && input.toLowerCase() === 'm') {
      openBatchSelection();
      return;
    }
    if (route.name === 'pluginList' && input === '/') {
      setSearchFocus(true);
      return;
    }
    if (route.name === 'pluginList' && focusZone === 'actions'
      && (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow)) {
      const direction = key.upArrow || key.leftArrow ? -1 : 1;
      setPinnedActionFocus((value) => moveFocus(pinnedActions, value, direction));
      return;
    }
    if (route.name === 'pluginList' && focusZone === 'actions' && key.return) {
      const actionIndex = Math.min(pinnedActionFocus, Math.max(0, pinnedActions.length - 1));
      runAction(pinnedActions[actionIndex]);
      return;
    }
    if (route.name === 'sourceList' && focusZone === 'actions'
      && (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow)) {
      setPinnedActionFocus((value) => moveFocus(pinnedActions, value,
        key.upArrow || key.leftArrow ? -1 : 1));
      return;
    }
    if (route.name === 'sourceList' && focusZone === 'actions' && key.return) {
      runAction(pinnedActions[pinnedActionFocus]);
      return;
    }
    if (route.name === 'projectStatus' && focusZone === 'actions'
      && (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow)) {
      setPinnedActionFocus((value) => moveFocus(pinnedActions, value,
        key.upArrow || key.leftArrow ? -1 : 1));
      return;
    }
    if (route.name === 'projectStatus' && focusZone === 'actions' && key.return) {
      runAction(pinnedActions[pinnedActionFocus]);
      return;
    }
    if (route.name === 'portableSkillSelect' && focusZone === 'actions'
      && (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow)) {
      setPinnedActionFocus((value) => moveFocus(pinnedActions, value,
        key.upArrow || key.leftArrow ? -1 : 1));
      return;
    }
    if (route.name === 'portableSkillSelect' && focusZone === 'actions' && key.return) {
      runAction(pinnedActions[pinnedActionFocus]);
      return;
    }
    if ((route.name === 'batchSelection' && batchDraft?.stage === 'select'
      || route.name === 'installTargets' && route.view !== 'blocked')
      && focusZone === 'actions'
      && (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow)) {
      setPinnedActionFocus((value) => moveFocus(pinnedActions, value,
        key.upArrow || key.leftArrow ? -1 : 1));
      return;
    }
    if ((route.name === 'batchSelection' && batchDraft?.stage === 'select'
      || route.name === 'installTargets' && route.view !== 'blocked')
      && focusZone === 'actions' && key.return) {
      runAction(pinnedActions[pinnedActionFocus]);
      return;
    }
    if ((route.name === 'batchInstallPlatforms' || route.name === 'batchInstallScope'
      || route.name === 'batchPlacement' && pinnedActions.length > 0)
      && focusZone === 'actions'
      && (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow)) {
      setPinnedActionFocus((value) => moveFocus(pinnedActions, value,
        key.upArrow || key.leftArrow ? -1 : 1));
      return;
    }
    if ((route.name === 'batchInstallPlatforms' || route.name === 'batchInstallScope'
      || route.name === 'batchPlacement' && pinnedActions.length > 0)
      && focusZone === 'actions' && key.return) {
      runAction(pinnedActions[pinnedActionFocus]);
      return;
    }
    if (route.name === 'configFields' && focusZone === 'actions'
      && (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow)) {
      setPinnedActionFocus((value) => moveFocus(pinnedActions, value,
        key.upArrow || key.leftArrow ? -1 : 1));
      return;
    }
    if (route.name === 'configFields' && focusZone === 'actions' && key.return) {
      runAction(pinnedActions[pinnedActionFocus]);
      return;
    }
    if (key.tab && (route.name === 'configLayer'
      || route.name === 'configFields'
      || route.name === 'configFieldEditor'
      || route.name === 'configObjectPropertyEditor')) {
      return;
    }
    if (route.name === 'pluginDependencies' && route.view !== 'removeBlocked'
      && (key.leftArrow || key.rightArrow)) {
      const unified = buildUnifiedDependencyGraphProjection({
        overviews: props.controller.listPluginDependencyOverviews(),
        rootPluginId: route.pluginId,
        ...(expandedDependencyPluginIds ? { expandedPluginIds: expandedDependencyPluginIds } : {}),
      });
      const row = unified.rows[focus];
      if (!row) return;
      const next = new Set(expandedDependencyPluginIds ?? [
        ...unified.dependencies.defaultExpandedPluginIds,
        ...unified.dependents.defaultExpandedPluginIds,
      ]);
      if (key.rightArrow && row.canExpand) next.add(row.pluginId);
      if (key.leftArrow && row.canExpand) next.delete(row.pluginId);
      const nextUnified = buildUnifiedDependencyGraphProjection({
        overviews: props.controller.listPluginDependencyOverviews(),
        rootPluginId: route.pluginId,
        expandedPluginIds: next,
      });
      const nextFocus = Math.max(0, nextUnified.rows.findIndex((candidate) =>
        candidate.id === row.id && candidate.branch === row.branch));
      const nextScroll = Math.min(scrollOffset, nextFocus);
      setExpandedDependencyPluginIds(next);
      setFocus(nextFocus);
      setScrollOffset(nextScroll);
      return;
    }
    const sessionNavigation = resolveTuiSessionNavigationKey(
      { input, key },
      { characterInput: isCharacterInputMode(route, searchFocus) },
    );
    const globalAction = resolveTuiGlobalKeyAction(
      { input, key },
      { mode: 'menu', allowBack: true },
    );
    if (sessionNavigation) {
      requestSessionNavigation(sessionNavigation);
    } else if (route.name === 'sourceAdd' && key.escape && route.step !== 'type') {
      back();
    } else if (input.toLowerCase() === 'o'
      && (route.name === 'home'
        || route.name === 'issueList'
        || route.name === 'issueDetail'
        || route.name === 'result')) {
      go({ name: 'operationHistory' });
    } else if (canOpenHelp && globalAction === 'help') {
      setOverlayFocus(0);
      setOverlay('help');
    } else if (globalAction === 'exit') {
      requestConfirmedExit();
    } else if (input.toLowerCase() === 'd' && supportsTechnicalDetails) {
      toggleTechnical();
    } else if (globalAction === 'back' && route.name === 'result' && portableResultDetailOpen) {
      setPortableResultDetailOpen(false);
      setPortableResultDetailOffset(0);
      setFocus(portableResultDetailReturnFocus.current);
      setScrollOffset(0);
    } else if (globalAction === 'back' && route.name === 'portableSkillSelect' && portableToolsOpen) {
      setPortableToolsOpen(false);
      setFocus(0);
      setScrollOffset(0);
    } else if (globalAction === 'back' && route.name === 'batchSelection'
      && batchDraft?.stage === 'select' && batchDraft.showSelectionTools) {
      setBatchDraft((current) => current ? { ...current, showSelectionTools: false } : current);
      setFocus(0);
      setScrollOffset(0);
    } else if (globalAction === 'back'
      && (route.name === 'configSave' || route.name === 'sourceSave')
      && route.view === 'changes') {
      back();
    } else if (globalAction === 'back' && route.name === 'configLayer') {
      back();
    } else if (globalAction === 'back'
      && route.name === 'configObjectPropertyEditor') {
      back();
    } else if (globalAction === 'back'
      && (route.name === 'configFieldEditor' || route.name === 'configFieldAction')) {
      setConfigCandidate(undefined);
      if (activeObjectKey) {
        setObjectDrafts((current) => Object.fromEntries(Object.entries(current)
          .filter(([key]) => key !== activeObjectKey)));
        setChangedObjectDraftKeys((current) => current.filter((key) => key !== activeObjectKey));
      }
      back();
    } else if (globalAction === 'back'
      && (route.name === 'batchInstallScope' || route.name === 'batchPlacement')) {
      if (batchDraft?.showPlacementTargets) {
        setBatchDraft((current) => current ? { ...current, showPlacementTargets: false } : current);
        restoreActionFocus('batch-placement-details');
      } else back();
    } else if (globalAction === 'back'
      && route.name === 'batchSelection'
      && batchDraft
      && batchDraft.stage !== 'select'
      && snapshot.router.currentFlowId === batchDraft.flowId) {
      moveBatchStage(batchDraft.stage === 'maintenance' ? 'task' : 'select');
    } else if (globalAction === 'back'
      && batchDraft
      && route.name !== 'batchSelection'
      && snapshot.router.currentFlowId === batchDraft.flowId
      && (route.name !== 'pluginWriteTask'
        || route.batchOrigin?.flowId === batchDraft.flowId)) {
      back();
    } else if (globalAction === 'back'
      && (route.name === 'operationHistory'
        || route.name === 'operationDiagnostic'
        || route.name === 'operationReportPreview')) {
      back();
    } else if (globalAction === 'back') {
      if (dirty && route.name !== 'review') {
        setOverlayFocus(0);
        setDiscardForExit(false);
        setOverlay('discard');
      } else back();
    } else if (route.name === 'pluginList' && input.toLowerCase() === 'f') {
      togglePluginListFilter?.();
    } else if (route.name === 'batchSelection' && batchDraft?.stage === 'select'
      && input.toLowerCase() === 'f') {
      const nextFilter = PLUGIN_FILTERS[(PLUGIN_FILTERS.indexOf(batchDraft.installFilter) + 1)
        % PLUGIN_FILTERS.length]!;
      setBatchDraft((current) => current ? {
        ...current,
        installFilter: nextFilter,
        showSelected: false,
      } : current);
      setFocus(0);
      setScrollOffset(0);
    } else if (route.name === 'pluginList' && route.mode === 'installed' && input.toLowerCase() === 'a') {
      prepareCurrentProjectPlugins();
    } else if (route.name === 'projectStatus' && input.toLowerCase() === 'c') {
      runAction(pinnedActions.find((action) => action.actionId === 'project-sync-actionable'));
    } else if (route.name === 'batchSelection' && batchDraft?.stage === 'select' && input.toLowerCase() === 'a') {
      const candidates = batchCandidates(batchDraft)
        .filter((candidate) => batchCandidateBlockReason(batchDraft, candidate) === undefined);
      setBatchDraft((current) => current ? {
        ...current,
        selectedPluginIds: [...new Set([
          ...current.selectedPluginIds,
          ...candidates.map((candidate) => candidate.pluginId),
        ])],
      } : current);
    } else if (route.name === 'installTargets' && route.view !== 'blocked'
      && input.toLowerCase() === 'c') {
      runAction(pinnedActions.find((action) => action.actionId === 'confirm-install-platforms'));
    } else if (route.name === 'batchInstallPlatforms' && input.toLowerCase() === 'c') {
      runAction(actions.find((action) => action.actionId === 'batch-install-platforms-confirm'));
    } else if (route.name === 'batchInstallScope' && input.toLowerCase() === 'c') {
      runAction(actions.find((action) => action.actionId === 'batch-placement-confirm'));
    } else if (route.name === 'batchPlacement' && pinnedActions.length > 0
      && input.toLowerCase() === 'c') {
      runAction(actions.find((action) => action.actionId === 'batch-placement-confirm'));
    } else if (route.name === 'batchSelection' && batchDraft?.stage === 'select' && input.toLowerCase() === 'c') {
      runAction(pinnedActions.find((action) => action.actionId === 'batch-selection-continue'));
    } else if (route.name === 'batchSelection' && batchDraft?.stage === 'select'
      && focusZone === 'content' && input === ' ') {
      const action = actions[normalizedEffectiveFocus];
      if (action?.pluginId
        && (batchDraft.selectedPluginIds.includes(action.pluginId) || action.canSelectNew)) {
        toggleBatchPlugin(action.pluginId);
      }
    } else if (route.name === 'installTargets' && route.view !== 'blocked'
      && focusZone === 'content' && input === ' ') {
      const action = actions[focus];
      if (action?.actionId?.startsWith('install-platform-')) runAction(action);
    } else if (route.name === 'batchSelection' && batchDraft?.stage === 'select' && input === '/') {
      setSearchFocus(true);
    } else if (route.name === 'batchSelection' && batchDraft?.stage === 'select'
      && (key.leftArrow || key.rightArrow || input === '[' || input === ']')) {
      const tabs = ['all', ...props.controller.listSources().map((source) => source.id)];
      const current = batchDraft.sourceId ?? 'all';
      const direction = key.leftArrow || input === '[' ? -1 : 1;
      const next = tabs[(tabs.indexOf(current) + direction + tabs.length) % tabs.length]!;
      setBatchDraft((draft) => draft ? {
        ...draft,
        ...(next === 'all' ? { sourceId: undefined } : { sourceId: next }),
        showSelected: false,
      } : draft);
      setFocus(0);
      setScrollOffset(0);
    } else if (route.name === 'configFields' && input.toLowerCase() === 's') {
      runAction(pinnedActions[0]);
    } else if (route.name === 'configFields' && input.toLowerCase() === 'u') {
      const key = actions[focus]?.configKey;
      const field = currentConfigPage?.groups.flatMap((group) => group.fields)
        .find((candidate) => candidate.key === key);
      const canUnset = (['project', 'user'] as const).some((scope) =>
        configLayerPages[scope]?.groups.flatMap((group) => group.fields)
          .some((candidate) => candidate.key === key && configFieldCanUnset(candidate)));
      if (field && canUnset) {
        removeDraft(field.key);
      }
    } else if (route.name === 'configFields' && visibleConfigTabs.length > 1
      && (key.leftArrow || key.rightArrow)) {
      const current = Math.max(0, visibleConfigTabs.findIndex((tab) => tab.id === activeConfigTabId));
      const direction = key.leftArrow ? -1 : 1;
      const next = visibleConfigTabs[(current + direction + visibleConfigTabs.length) % visibleConfigTabs.length]!;
      props.controller.updatePageContext({ configGroupId: next.id, focusIndex: 0, scrollOffset: 0 });
      setFocus(0);
      setScrollOffset(0);
    } else if ((input.toLowerCase() === 'r' || input.toLowerCase() === 'c')
      && (route.name === 'sourceDetail' || route.name === 'sourceMore')) {
      void props.controller.recheckCatalogSource(route.sourceId);
    } else if ((input.toLowerCase() === 'r' || input.toLowerCase() === 'c')
      && route.name === 'sourceList') {
      void props.controller.recheckAllCatalogSources();
    } else if (route.name === 'pluginList' && (key.leftArrow || key.rightArrow || input === '[' || input === ']')) {
      const direction = key.leftArrow || input === '[' ? -1 : 1;
      movePluginListSource?.(direction);
    } else if (input.toLowerCase() === 'c' && route.name === 'portableSkillSelect') {
      runAction(pinnedActions.find((action) => action.actionId === 'portable-selection-continue'));
    } else if (input.toLowerCase() === 'a' && route.name === 'portableSkillSelect') {
      runAction(selectAllPortableCandidates);
    } else if (input === ' ' && route.name === 'portableSkillSelect'
      && focusZone === 'content' && !portableToolsOpen) {
      const candidate = portableVisibleCandidates[focus];
      if (candidate) props.controller.togglePortableSkill(candidate.name);
    } else if (key.upArrow || input.toLowerCase() === 'k') {
      if (route.name === 'pluginDependencyNode' && route.view === 'references' && !showTechnical) {
        setBatchTargetOffset(0);
      }
      setFocus((value) => {
        const current = route.name === 'batchSelection' && batchDraft?.stage === 'select'
          ? normalizedEffectiveFocus : dynamicActionIds ? effectiveFocus : value;
        const next = pluginRows.length > 0 ? moveIndex(pluginRows.length, current, -1)
          : route.name === 'sourceDetail' ? moveIndex(actions.length, current, -1)
            : moveFocus(actions, current, -1);
        if (dynamicActionIds && dynamicActionSignature !== undefined) {
          dynamicMenuFocus.current = {
            routeKey,
            actionIds: dynamicActionSignature,
            focusedActionId: dynamicActionIds[next],
          };
        }
        const viewport = route.name === 'batchSelection' && batchDraft?.stage === 'select'
          ? batchDraft.showSelectionTools
            ? actionViewport(actions, policy.mode === 'compact', next, scrollOffset,
                Math.max(1, pageActionBudget(4)))
            : objectCardActionViewport(actions, Math.max(20, size.columns - 2),
                policy.mode === 'compact', next, scrollOffset, Math.max(1, pageActionBudget(4)))
          : route.name === 'portableSkillSelect' && snapshot.portableDraft && !portableToolsOpen
          ? portableSkillCandidateViewport(
              actions.slice(0, portableVisibleCandidates.length),
              Math.max(20, size.columns - 2),
              policy.mode === 'compact',
              next,
              scrollOffset,
              pageActionBudget(
                actions.length - portableVisibleCandidates.length
                + (portableVariantCandidates.length > 0 ? 3 : 0),
              ),
            )
          : route.name === 'installTargets' && route.view !== 'blocked'
            ? objectCardActionViewport(actions, Math.max(20, size.columns - 2),
                policy.mode === 'compact', next, scrollOffset,
                Math.max(1, pageActionBudget((pinnedActions[0]?.disabled ? 2 : 1)
                  + (policy.mode === 'compact' ? 4 : 0))))
          : actionViewport(
              actions,
              route.name === 'pluginDetail' || policy.mode === 'compact',
              next,
              scrollOffset,
              currentActionViewportLineBudget,
            );
        if (route.name === 'pluginDependencies' && route.view !== 'removeBlocked') {
          const projection = buildUnifiedDependencyGraphProjection({
            overviews: props.controller.listPluginDependencyOverviews(),
            rootPluginId: route.pluginId,
            ...(expandedDependencyPluginIds ? { expandedPluginIds: expandedDependencyPluginIds } : {}),
          });
          persistUnifiedDependencyGraphContext(
            route.pluginId,
            projection,
            expandedDependencyPluginIds ?? new Set([
              ...projection.dependencies.defaultExpandedPluginIds,
              ...projection.dependents.defaultExpandedPluginIds,
            ]),
            next,
            viewport.offset,
          );
        }
        setScrollOffset(viewport.offset);
        return next;
      });
    } else if (key.downArrow || input.toLowerCase() === 'j') {
      if (route.name === 'pluginDependencyNode' && route.view === 'references' && !showTechnical) {
        setBatchTargetOffset(0);
      }
      setFocus((value) => {
        const current = route.name === 'batchSelection' && batchDraft?.stage === 'select'
          ? normalizedEffectiveFocus : dynamicActionIds ? effectiveFocus : value;
        const next = pluginRows.length > 0 ? moveIndex(pluginRows.length, current, 1)
          : route.name === 'sourceDetail' ? moveIndex(actions.length, current, 1)
            : moveFocus(actions, current, 1);
        if (dynamicActionIds && dynamicActionSignature !== undefined) {
          dynamicMenuFocus.current = {
            routeKey,
            actionIds: dynamicActionSignature,
            focusedActionId: dynamicActionIds[next],
          };
        }
        const viewport = route.name === 'batchSelection' && batchDraft?.stage === 'select'
          ? batchDraft.showSelectionTools
            ? actionViewport(actions, policy.mode === 'compact', next, scrollOffset,
                Math.max(1, pageActionBudget(4)))
            : objectCardActionViewport(actions, Math.max(20, size.columns - 2),
                policy.mode === 'compact', next, scrollOffset, Math.max(1, pageActionBudget(4)))
          : route.name === 'portableSkillSelect' && snapshot.portableDraft && !portableToolsOpen
          ? portableSkillCandidateViewport(
              actions.slice(0, portableVisibleCandidates.length),
              Math.max(20, size.columns - 2),
              policy.mode === 'compact',
              next,
              scrollOffset,
              pageActionBudget(
                actions.length - portableVisibleCandidates.length
                + (portableVariantCandidates.length > 0 ? 3 : 0),
              ),
            )
          : route.name === 'installTargets' && route.view !== 'blocked'
            ? objectCardActionViewport(actions, Math.max(20, size.columns - 2),
                policy.mode === 'compact', next, scrollOffset,
                Math.max(1, pageActionBudget((pinnedActions[0]?.disabled ? 2 : 1)
                  + (policy.mode === 'compact' ? 4 : 0))))
          : actionViewport(
              actions,
              route.name === 'pluginDetail' || policy.mode === 'compact',
              next,
              scrollOffset,
              currentActionViewportLineBudget,
            );
        if (route.name === 'pluginDependencies' && route.view !== 'removeBlocked') {
          const projection = buildUnifiedDependencyGraphProjection({
            overviews: props.controller.listPluginDependencyOverviews(),
            rootPluginId: route.pluginId,
            ...(expandedDependencyPluginIds ? { expandedPluginIds: expandedDependencyPluginIds } : {}),
          });
          persistUnifiedDependencyGraphContext(
            route.pluginId,
            projection,
            expandedDependencyPluginIds ?? new Set([
              ...projection.dependencies.defaultExpandedPluginIds,
              ...projection.dependents.defaultExpandedPluginIds,
            ]),
            next,
            viewport.offset,
          );
        }
        setScrollOffset(viewport.offset);
        return next;
      });
    } else if (key.return && route.name === 'pluginList' && focusZone === 'content' && pluginRows[focus]) {
      const row = pluginRows[focus]!;
      if (row.menuAction) row.menuAction();
      else go({ name: 'pluginDetail', pluginId: row.pluginId });
    } else if (key.return) {
      runAction(actions[normalizedEffectiveFocus]);
    }
  });

  if (tooSmall && !overlay) {
    return (
      <ScreenFrame title="终端空间不足" breadcrumb="终端空间不足" context={`${size.columns} × ${size.rows}`} help="q 退出" size={size}>
        <Callout status="warning" title="↔ 请将终端调整到至少 60 × 18" description="调整后会返回原页面，不会丢失当前选择。" />
      </ScreenFrame>
    );
  }

  if (actionError) description = actionError;
  const base = (
    <ScreenFrame title={projectReminderOpen ? '' : title}
      description={projectReminderOpen ? undefined : description}
      breadcrumb={breadcrumb} context={context}
      help={portableEmptySelectionOpen ? 'Enter 返回选择 · Esc 返回' : help} size={size}>
      {projectReminderOpen || sourceTransportOverlay ? null : content}
    </ScreenFrame>
  );
  if (portableEmptySelectionOpen) {
    const modalWidth = Math.max(40, Math.floor(size.columns * 0.6));
    return <Box position="relative" width={size.columns} height={size.rows}>
      <Box>{base}</Box>
      <Box position="absolute" marginTop={7}
        marginLeft={Math.max(2, Math.floor((size.columns - modalWidth) / 2))}
        width={modalWidth} flexDirection="column" backgroundColor={tuiTheme.colors.panelBackground}>
        <ReviewCard title="还没有选择 Skill"
          description="用 Space 勾选；也可以打开选择工具。">
          <SemanticRows actions={[{ label: '返回选择' }]} focus={0} kind="action" compact />
        </ReviewCard>
      </Box>
    </Box>;
  }
  if (projectReminderOpen && snapshot.projectIntentReminder) {
    const reminder = snapshot.projectIntentReminder;
    const pluginCount = new Set([
      ...reminder.actionableTargets,
      ...reminder.blockedTargets,
      ...reminder.unconfirmedTargets,
    ].map((target) => target.pluginId)).size;
    const reminderActions: ActionItem[] = [
      { label: '稍后处理', description: '首页会保留项目插件入口' },
      {
        label: `查看并同步 ${reminder.actionableTargets.length} 个位置`,
        description: `先显示完整操作汇总和脚本影响，再单独确认；保留 ${reminder.blockedTargets.length} 个受阻位置和 ${reminder.unconfirmedTargets.length} 个未确认位置`,
        disabled: reminder.actionableTargets.length === 0 ? '当前没有已确认可同步的目标' : undefined,
      },
      { label: '查看全部项目插件', description: '包含需要先处理和无法确认的项目目标' },
    ];
    const reminderWidth = Math.max(40, size.columns - (policy.mode === 'compact' ? 8 : 16));
    return <Box position="relative" width={size.columns} height={size.rows}>
      <Box>{base}</Box>
      <Box position="absolute" marginTop={policy.mode === 'compact' ? 2 : 5}
        marginLeft={Math.max(2, Math.floor((size.columns - reminderWidth) / 2))}
        width={reminderWidth} flexDirection="column">
        <ReviewCard
          title={`本项目有 ${pluginCount} 个插件尚未就绪`}
          description={`${reminder.actionableTargets.length} 个位置可同步；`
            + `${reminder.blockedTargets.length} 个位置需要先处理；`
            + `${reminder.unconfirmedTargets.length} 个位置未确认。`}
        >
          <StaticRow title="按项目共享设置恢复，个人设置不会被清空。" compact />
          <StaticRow title="确认同步前可查看脚本和完整影响。" status="warning" compact />
          <SemanticRows actions={reminderActions} focus={overlayFocus} kind="action" compact />
          <StaticRow title="↑↓ 选择 · Enter 确认 · Esc 稍后处理" status="muted" compact />
        </ReviewCard>
      </Box>
    </Box>;
  }
  if (operationConfirmation && snapshot.activeReview) {
    const review = snapshot.activeReview;
    const portableUserConfirmation = review.operationKind === 'portableInstall'
      && snapshot.portableDraft?.scope === 'user';
    const confirmationRiskLines = (columns: number): string[] => portableUserConfirmation
      ? [
          '! 本次在所有项目范围安装选定 Skills。',
          '具体对象和范围以刚才的汇总为准。',
        ].flatMap((line) => wrapConsoleText(line, Math.max(1, columns - 2)))
      : operationRiskLines(review, columns);
    const modalWidth = portableUserConfirmation
      ? Math.max(40, size.columns - (policy.mode === 'compact' ? 8 : 16))
      : Math.max(40, Math.floor(size.columns * 0.6));
    const modalMarginLeft = portableUserConfirmation
      ? Math.max(2, Math.floor((size.columns - modalWidth) / 2))
      : Math.max(2, Math.floor(size.columns / 5));
    const modalWarningLines = confirmationRiskLines(Math.max(12, modalWidth - 6));
    const shortWarningLimit = policy.mode === 'compact' ? 4 : 6;
    const shortConfirmation = modalWarningLines.length <= shortWarningLimit;
    const warningLines = shortConfirmation
      ? modalWarningLines
      : confirmationRiskLines(Math.max(12, size.columns - 8));
    const warningLimit = Math.max(1, policy.mode === 'compact' ? 1 : 7);
    const warningOffset = Math.min(operationConfirmation.warningOffset,
      Math.max(0, warningLines.length - 1));
    const visibleWarnings = shortConfirmation
      ? warningLines : warningLines.slice(warningOffset, warningOffset + warningLimit);
    const warningPaginated = !shortConfirmation && warningLines.length > warningLimit;
    const moveWarningPage = (direction: -1 | 1): void => {
      setOperationConfirmation((current) => current ? {
        ...current,
        warningOffset: Math.min(Math.max(0, warningLines.length - 1),
          Math.max(0, current.warningOffset + direction * warningLimit)),
      } : current);
    };
    if (warningPaginated) {
      confirmationPagination = { total: warningLines.length, pageRows: warningLimit };
    }
    const confirmationActions: ActionItem[] = [
      { label: '返回检查', description: '回到完整操作汇总' },
      {
        label: portableUserConfirmation ? '确认并执行' : `我已了解影响，${review.primaryLabel}`,
        status: 'error',
      },
      ...(warningPaginated ? paginationActions({
        offset: warningOffset,
        total: warningLines.length,
        pageRows: warningLimit,
        move: moveWarningPage,
      }) : []),
    ];
    const confirmationCard = (
      <ReviewCard title={portableUserConfirmation ? '确认本次影响' : '请确认本次风险'}
        description="确认只对当前操作汇总有效；内容变化后必须重新检查。">
        {!shortConfirmation && warningOffset > 0 ? <StaticRow title={`↑ 前面还有 ${warningOffset} 行`} status="muted" compact /> : null}
        {visibleWarnings.length > 0
          ? visibleWarnings.map((warning, index) => <StaticRow key={`${warningOffset + index}:${warning}`} title={warning} status={warning.startsWith('! ') ? 'warning' : 'info'} compact />)
          : <StaticRow title="! 此操作需要明确授权" status="warning" compact />}
        {!shortConfirmation && warningLines.length - warningOffset - visibleWarnings.length > 0
          ? <StaticRow title={`↓ 后面还有 ${warningLines.length - warningOffset - visibleWarnings.length} 行`} status="muted" compact /> : null}
        <SemanticRows actions={confirmationActions} focus={overlayFocus} kind="action" compact />
      </ReviewCard>
    );
    if (shortConfirmation) {
      return <Box position="relative" width={size.columns} height={size.rows}>
        <Box>{base}</Box>
        <Box position="absolute" marginTop={5} marginLeft={modalMarginLeft}
          width={modalWidth} flexDirection="column">
          {confirmationCard}
        </Box>
      </Box>;
    }
    return <ScreenFrame
      title={review.operationKind === 'catalogStorePrune'
        ? `确认${review.title}？`
        : `确认${review.title} ${review.subject.name}？`}
      breadcrumb={`${review.subject.name} / 风险确认`}
      context="独立授权"
      help="PgUp/PgDn 查看全部警告 · ↑↓ 移动 · Enter 选择 · Esc 返回"
      size={size}
    >{confirmationCard}</ScreenFrame>;
  }
  if (sourceTransportOverlay) {
    const configuredSource = route.name === 'sourceEdit'
      ? props.controller.getConfiguredSource(route.sourceId)
      : undefined;
    const currentLocation = sourceDraft?.owner === sourceTransportOverlay.owner
      && sourceDraft.type === 'git'
      ? sourceDraft.location
      : configuredSource?.type === 'git' ? configuredSource.url : undefined;
    const currentTransport = currentLocation === OFFICIAL_CATALOG_SOURCE_URL ? 'HTTPS'
      : currentLocation === OFFICIAL_CATALOG_SOURCE_SSH_URL ? 'SSH' : undefined;
    const transportActions: ActionItem[] = [
      { label: 'HTTPS', description: '默认方式；无需预先配置 SSH 密钥', selected: currentTransport === 'HTTPS' },
      { label: 'SSH', description: '适合已配置 GitHub SSH 访问的用户', selected: currentTransport === 'SSH' },
    ];
    return <Box position="relative" width={size.columns} height={size.rows}>
      <Box>{base}</Box>
      <Box position="absolute" marginTop={4} marginLeft={2}
        width={size.columns - 4} flexDirection="column">
        <ReviewCard title="选择下载方式" description={`当前草稿：${currentTransport ?? '未识别'}；仅修改草稿，保存前可查看汇总。`}>
          <SemanticRows actions={transportActions} focus={overlayFocus} kind="choice" compact={false} />
          <Text color={tuiTheme.colors.muted}>↑↓ 选择 · Enter 确认 · Esc 取消</Text>
        </ReviewCard>
      </Box>
    </Box>;
  }
  if (pluginListChooser && route.name === 'pluginList') {
    const sourceId = route.sourceId ?? 'all';
    const chooserActions: ActionItem[] = pluginListChooser.kind === 'source'
      ? [
          { label: '全部来源', selected: sourceId === 'all' },
          ...props.controller.listSources().map((source) => ({
            label: source.label,
            meta: source.id === source.label ? undefined : source.id,
            selected: source.id === sourceId,
          })),
        ]
      : PLUGIN_FILTERS.map((filter) => ({
          label: pluginFilterLabel(filter),
          selected: filter === installFilter,
        }));
    const chooserFocus = Math.min(pluginListChooser.focus, Math.max(0, chooserActions.length - 1));
    const chooserViewport = rowViewport({
      rowHeights: chooserActions.map(() => 1),
      focus: chooserFocus,
      requestedOffset: 0,
      rowBudget: responsiveBudget(6, 9),
    });
    const chooserWidth = Math.max(40, Math.floor(size.columns * 0.8));
    return <Box position="relative" width={size.columns} height={size.rows}>
      <Box>{base}</Box>
      <Box position="absolute" marginTop={policy.mode === 'compact' ? 2 : 5}
        marginLeft={Math.max(2, Math.floor((size.columns - chooserWidth) / 2))}
        width={chooserWidth} flexDirection="column">
        <ReviewCard
          title={pluginListChooser.kind === 'source' ? '选择插件来源' : '筛选插件'}
          description={pluginListChooser.kind === 'status' ? '只改变列表，不改变插件详情。' : undefined}
        >
          <SemanticRows actions={chooserActions} focus={chooserFocus} kind="choice" compact
            offset={chooserViewport.offset} limit={chooserViewport.limit} />
          {chooserActions.length > chooserViewport.limit
            ? <StaticRow title={`${chooserViewport.position} / ${chooserViewport.total}`} status="muted" compact />
            : null}
          <StaticRow title="↑↓ 选择 · Enter 确认 · Esc 取消" status="muted" compact />
        </ReviewCard>
      </Box>
    </Box>;
  }
  if (!overlay) return base;
  const helpRows = helpRowsForRoute(
    route,
    actions.length,
    supportsTechnicalDetails,
    busy,
    props.onSessionNavigation !== undefined,
  );
  const overlayActions: ActionItem[] = overlay === 'help'
    ? [
        { label: '关闭' },
        ...(props.onSessionNavigation ? [
          { label: '返回首页' },
          { label: '返回首页并重新加载' },
        ] : []),
      ]
    : [
        { label: overlay === 'discard' || overlay === 'sessionNavigation' ? '继续编辑' : '继续使用' },
        { label: overlay === 'discard' || overlay === 'sessionNavigation' ? '放弃修改' : '退出', status: 'error' },
      ];
  return (
    <Box position="relative" width={size.columns} height={size.rows}>
      <Box>{overlay === 'help' ? null : base}</Box>
      <Box position="absolute" marginTop={overlay === 'help' ? 0 : 5}
        marginLeft={overlay === 'help' ? 1 : Math.max(2, Math.floor(size.columns / 5))}
        width={overlay === 'help' ? size.columns - 2 : Math.max(40, Math.floor(size.columns * 0.6))} flexDirection="column">
        <ReviewCard title={overlay === 'help' ? '当前页快捷键'
          : overlay === 'discard' || overlay === 'sessionNavigation' ? '放弃未保存修改？'
          : '退出控制台？'}>
        {overlay === 'help'
          ? <>{helpRows.map(([key, value]) => <StaticRow key={key} title={`${key}  ${value}`} compact />)}</>
          : <StaticRow title={overlay === 'discard'
            ? discardForExit ? '放弃后将退出控制台。' : '放弃后将返回上一页。'
            : overlay === 'sessionNavigation'
              ? `放弃后将${discardForSessionNavigation === 'reload' ? '重新读取本地状态' : '返回首页'}。`
              : '进行中的写操作会先完成。'} status="muted" />}
        <SemanticRows actions={overlayActions} focus={overlayFocus} kind="action" compact />
        </ReviewCard>
      </Box>
    </Box>
  );
}
