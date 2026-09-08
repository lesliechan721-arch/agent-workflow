import { Box, Text, useInput, useWindowSize } from 'ink';
import { useEffect, useRef, useState } from 'react';
import path from 'node:path';
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
import { normalizePortableAgents } from '../portable/commands.js';
import {
  selectLifecycleRetryAction,
} from '../commands/operation-planner.js';
import {
  parseScriptTimeoutMs,
  SCRIPT_TIMEOUT_DEFAULT_MS,
  SCRIPT_TIMEOUT_MAX_MS,
  SCRIPT_TIMEOUT_MIN_MS,
} from '../commands/options.js';
import { projectCatalogSourceLocation } from '../utils/catalog-source-presentation.js';
import type {
  CatalogDevManagementViewModel,
  CatalogPublicationManagementViewModel,
  CatalogStoreManagementViewModel,
  CatalogValidationViewModel,
  CatalogWorkspaceManagementViewModel,
} from './catalog-management.js';
import {
  ActionRow,
  Callout,
  ChoiceRow,
  diagnosticDetailRowCount,
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
  BatchPluginWriteAction,
  ExternalDraftState,
  OperationIntent,
  OperationReviewChange,
  OperationResultSummary,
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
  CatalogManagementIntro,
  CatalogPublicationSummary,
  CatalogStoreSummary,
  CatalogWorkspaceSummary,
} from './catalog-management-screens.js';
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
  type DependencyGraphRow,
} from './dependency-graph.js';
import { platformLabel, scopeLabel } from './glossary.js';
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

interface ActionItem {
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
}

interface DynamicMenuFocus {
  routeKey: string;
  actionIds: string;
  focusedActionId?: string;
}

interface ConfigDraftIssue {
  key: string;
  source: 'update' | 'remove' | 'object';
}

type SourceOperationBlockReason = NonNullable<ReturnType<TuiController['catalogSourceRecoveryBlockReason']>>;

function sourceOperationBlockLabel(reason: SourceOperationBlockReason): string {
  switch (reason) {
    case 'configDraft': return '未保存的插件设置';
    case 'sourceDraft': return '未保存的来源修改';
    case 'batchDraft': return '未完成的批量操作选择';
    case 'catalogDraft': return '未完成的 Catalog 管理输入';
    case 'portableDraft': return '未完成的通用 Skills 选择';
    case 'activeReview': return '等待确认的操作';
    case 'reviewPreparation': return '正在准备确认信息的操作';
    case 'writeProgress': return '正在执行的写入操作';
  }
}

type CatalogGenerationState = NonNullable<CatalogSourceGenerationViewModel['state']>;

function catalogGenerationStateLabel(state: CatalogGenerationState | undefined): string {
  switch (state) {
    case 'ready': return '可用';
    case 'activationRequired': return '需要启用';
    case 'repairRequired': return '需要修复';
    case 'configMismatch': return '来源设置已变化';
    case 'stateInvalid': return '版本状态需要恢复';
    case 'incompatible': return '当前 AW 不兼容';
    case 'unavailable': return '不可用';
    case undefined: return '尚未取得状态';
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
  mode: 'browse' | 'installed';
  stage: 'select' | 'task' | 'maintenance';
  selection: 'selected' | 'currentProjectIntentRoots';
  selectedPluginIds: string[];
  platform: PlatformName | 'both';
  scope: Scope;
  sourceId?: string;
  query: string;
  installFilter: PluginInstallFilter;
  showSelected: boolean;
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

interface CatalogWorkspaceDraft {
  ownerName: string;
  ownerUrl: string;
  displayName: string;
  catalogVersion: string;
}

interface CatalogPublishDraft {
  targetKind: 'remote' | 'remoteUrl';
  target: string;
  branch: string;
  expectedPlanDigest?: string;
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
    || route.name === 'catalogWorkspace'
      && (route.view === 'select' || route.view === 'create'
        || route.view === 'version' && route.step === 'catalogVersion')
    || route.name === 'catalogDev' && route.step !== undefined && route.step !== 'overview'
    || route.name === 'catalogPublish' && route.step !== 'overview'
    || route.name === 'scriptTimeout';
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
    if (route.mode === 'browse') rows.push(['f', '切换全部或未安装']);
  }
  if (route.name === 'portableSkillSelect') {
    rows.push(['Space', '切换当前 Skill']);
    rows.push(['a', '全选 Skills']);
  }
  if (route.name === 'batchSelection') {
    rows.push(['Space', '切换当前插件']);
    rows.push(['a', '全选或清空当前列表']);
    rows.push(['c', '继续选择位置和平台']);
  }
  if (route.name === 'configFields' && route.layer.scope !== 'effective') {
    rows.push(['s', '查看保存汇总']);
    rows.push(['u', '恢复当前字段继承']);
  }
  if (route.name === 'sourceList' || route.name === 'sourceDetail' || route.name === 'sourceMore') {
    rows.push(['r', '重新检查来源']);
  }
  if (supportsTechnicalDetails) {
    rows.push(['d', route.name === 'progress' ? '打开技术进度' : '打开技术详情']);
  }
  if (sessionNavigation && !busy && !isCharacterInputMode(route, false)) {
    rows.push(['h', '返回首页']);
    rows.push(['H', '重新读取本地状态']);
  }
  if (sessionNavigation && busy) {
    rows.push(['h / H', '操作成功后返回首页或重新读取']);
    rows.push(['Esc', '撤销等待中的页面跳转']);
  }
  rows.push(['q / Ctrl-C', busy ? '操作完成后退出' : '退出控制台']);
  rows.push(['? / o', '关闭帮助 / 查看操作记录']);
  return rows;
}

function configOwnerKey(route: Extract<TuiRoute, {
  name: 'configFields' | 'configFieldEditor' | 'configObjectPropertyEditor' | 'configFieldAction' | 'configSave';
}>): string {
  return `${route.pluginId}\0${route.layer.scope}`;
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

function dependencyGraphActionIds(
  projection: ReturnType<typeof buildDependencyGraphProjection>,
): string[] {
  return [
    ...projection.rows.map((row) => `row:${row.id}`),
    ...projection.scopeSummary.unknownConsumerPluginIds.map((pluginId) => `unverified:${pluginId}`),
    'direction',
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

function pluginPlacementSummary(plugin: PluginListItemViewModel): string {
  if (plugin.configOnly) {
    return plugin.savedConfigScopes.length > 0
      ? `已保存${plugin.savedConfigScopes.map(scopeLabel).join('、')}设置`
      : '已保存设置';
  }
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
      : placement.actualState === 'blocked' ? '已阻断'
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
        .map((row, visibleIndex) => row.menuAction ? (
          <TaskRow
            key={row.pluginId}
            title={row.name}
            description={row.description}
            meta={row.statusLabel}
            status={row.status}
            focused={props.viewport.offset + visibleIndex === props.focus}
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
    value: `${placement.desiredScopes?.map(scopeLabel).join('+') || scopeLabel(placement.scope)} · ${placement.actualState === 'needsSync' ? '需要同步' : placement.actualState === 'blocked' ? '已阻断' : placement.health === 'ready' ? '可用' : placement.health === 'incomplete' ? '需要处理' : '不可用'}`,
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
      const actualScopes = [
        ...(entry.activation?.user ? ['所有项目'] : []),
        ...(entry.activation?.project ? ['当前项目'] : []),
      ];
      const actual = actualScopes.join('+') || scopeLabel(entry.scope);
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
}): React.JSX.Element {
  const windowSize = useWindowSize();
  const size = props.size ?? windowSize;
  const policy = resolveTuiSizePolicy(size.columns, size.rows);
  const [snapshot, setSnapshot] = useState(props.controller.snapshot);
  const [overlay, setOverlay] = useState<Overlay>();
  const [overlayFocus, setOverlayFocus] = useState(0);
  const [discardForExit, setDiscardForExit] = useState(false);
  const [discardForSessionNavigation, setDiscardForSessionNavigation] = useState<SessionNavigation>();
  const [discardDraftConfirmation, setDiscardDraftConfirmation] = useState<ExternalDraftState[]>();
  const [focus, setFocus] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [searchFocus, setSearchFocus] = useState(false);
  const [query, setQuery] = useState(
    props.controller.snapshot.router.current.context.query ?? '',
  );
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
  const [configLayerPages, setConfigLayerPages] = useState<Partial<Record<Scope, ConfigPageViewModel>>>({});
  const [configSaveImpact, setConfigSaveImpact] = useState<Awaited<ReturnType<TuiController['previewConfigSaveImpact']>>>();
  const [configSaveImpactError, setConfigSaveImpactError] = useState(false);
  const [draftUpdates, setDraftUpdates] = useState<Record<string, PluginConfigValue>>({});
  const [draftRemoves, setDraftRemoves] = useState<string[]>([]);
  const [objectDrafts, setObjectDrafts] = useState<Record<string, PluginConfigObject>>({});
  const [changedObjectDraftKeys, setChangedObjectDraftKeys] = useState<string[]>([]);
  const [objectError, setObjectError] = useState<string>();
  const [inputValue, setInputValue] = useState('');
  const [inputError, setInputError] = useState<string>();
  const [configActionError, setConfigActionError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [configResetAvailability, setConfigResetAvailability] = useState<Partial<Record<
    Scope,
    Awaited<ReturnType<TuiController['getConfigResetAvailability']>>
  >>>({});
  const [sourceDraft, setSourceDraft] = useState<SourceDraft>();
  const [batchDraft, setBatchDraft] = useState<BatchDraft>();
  const [batchTargetOffset, setBatchTargetOffset] = useState(0);
  const [expandedDependencyPluginIds, setExpandedDependencyPluginIds] = useState<Set<string>>();
  const [sourceInput, setSourceInput] = useState('');
  const [sourceInputError, setSourceInputError] = useState<string>();
  const [catalogInput, setCatalogInput] = useState('');
  const [catalogInputError, setCatalogInputError] = useState<string>();
  const [catalogWorkspace, setCatalogWorkspace] = useState<CatalogWorkspaceManagementViewModel>();
  const [catalogValidation, setCatalogValidation] = useState<CatalogValidationViewModel>();
  const [catalogDev, setCatalogDev] = useState<CatalogDevManagementViewModel>();
  const [catalogStore, setCatalogStore] = useState<CatalogStoreManagementViewModel>();
  const [catalogPublication, setCatalogPublication] = useState<CatalogPublicationManagementViewModel>();
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogWorkspaceDraft, setCatalogWorkspaceDraft] = useState<CatalogWorkspaceDraft>({
    ownerName: '', ownerUrl: '', displayName: '', catalogVersion: '0.1.0',
  });
  const [catalogPublishDraft, setCatalogPublishDraft] = useState<CatalogPublishDraft>({
    targetKind: 'remote', target: '', branch: 'catalog',
  });
  const [catalogDevSourceId, setCatalogDevSourceId] = useState('');
  const [pendingReviewIntent, setPendingReviewIntent] = useState<OperationIntent>();
  const pendingReviewIntentRef = useRef<OperationIntent | undefined>(undefined);
  const [scriptTimeoutInput, setScriptTimeoutInput] = useState(String(SCRIPT_TIMEOUT_DEFAULT_MS));
  const [scriptTimeoutError, setScriptTimeoutError] = useState<string>();
  const [sourceReferenceSummary, setSourceReferenceSummary] = useState<Awaited<ReturnType<TuiController['inspectSourceRemoval']>>>();
  const [sourceDependenciesExpanded, setSourceDependenciesExpanded] = useState(false);
  const [portableAgentInput, setPortableAgentInput] = useState('');
  const [reportSaveMode, setReportSaveMode] = useState(false);
  const [reportSavePath, setReportSavePath] = useState('');
  const [reportSaveResult, setReportSaveResult] = useState<string>();
  const [reportSaveError, setReportSaveError] = useState<string>();
  const [draftOwner, setDraftOwner] = useState<string>();
  const [pendingPresetId, setPendingPresetId] = useState<string>();
  const [pendingLayerFieldKey, setPendingLayerFieldKey] = useState<string>();
  const [confirmedSharedReviewToken, setConfirmedSharedReviewToken] = useState<string>();
  const dynamicMenuFocus = useRef<DynamicMenuFocus | undefined>(undefined);
  const dependencyGraphContexts = useRef(new Map<string, DependencyGraphSessionContext>());
  const externalDraftRevision = useRef({ config: 0, source: 0, batch: 0, catalog: 0 });
  const previousExternalDraftValues = useRef({
    draftUpdates, draftRemoves, objectDrafts, changedObjectDraftKeys, sourceDraft, batchDraft,
    catalogInput, catalogWorkspaceDraft, catalogPublishDraft, catalogDevSourceId,
  });
  const externalDraftFlowIds = useRef(new Map<string, string>());
  const exitSent = useRef(false);
  const operationBusy = useRef(false);
  const route = snapshot.router.current.route;
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
    if (snapshot.result.operationKind === 'configSave'
      || snapshot.result.operationKind === 'configReset') {
      setDirty(false);
      setDraftUpdates({});
      setDraftRemoves([]);
      setObjectDrafts({});
      setChangedObjectDraftKeys([]);
      setObjectError(undefined);
    }
    if ((snapshot.result.operationKind === 'sourceMutation'
      || snapshot.result.operationKind === 'catalogGeneration') && sourceDraft) {
      setSourceDraft(undefined);
      setDirty(Object.keys(draftUpdates).length + draftRemoves.length + changedObjectDraftKeys.length > 0);
    }
  }, [route.name, snapshot.result]);
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
    if (route.name !== 'result'
      || snapshot.result?.state !== 'succeeded'
      || snapshot.result.operationKind !== 'catalogManagement') return;
    const action = snapshot.result.summary.catalogManagement?.action;
    if (action === 'workspaceInit') {
      setCatalogInput('');
      setCatalogWorkspaceDraft({
        ownerName: '', ownerUrl: '', displayName: '', catalogVersion: '0.1.0',
      });
    }
    if (action === 'publishApply') {
      setCatalogInput('');
      setCatalogPublishDraft({ targetKind: 'remote', target: '', branch: 'catalog' });
    }
  }, [route.name, snapshot.result]);
  useEffect(() => {
    if (!batchDraft || (route.name !== 'batchSelection' && route.name !== 'batchPlacement')) return;
    setDirty(true);
  }, [batchDraft, route.name]);
  useEffect(() => {
    if (route.name !== 'sourceAdd') setSourceInput('');
  }, [route.name]);
  useEffect(() => {
    if (route.name !== 'catalogWorkspace' || route.view !== 'overview') return;
    let current = true;
    setCatalogLoading(true);
    setCatalogInputError(undefined);
    void props.controller.getCatalogWorkspaceManagement()
      .then((value) => { if (current) setCatalogWorkspace(value); })
      .catch((error: unknown) => {
        if (current) setCatalogInputError(sanitizeDiagnosticText(
          error instanceof Error ? error.message : String(error), [], [catalogInput],
        ));
      })
      .finally(() => { if (current) setCatalogLoading(false); });
    return () => { current = false; };
  }, [props.controller, route.name, route.name === 'catalogWorkspace' ? route.view : '']);
  useEffect(() => {
    if (route.name !== 'catalogDev' || route.step && route.step !== 'overview') return;
    let current = true;
    setCatalogLoading(true);
    setCatalogInputError(undefined);
    void props.controller.getCatalogDevManagement()
      .then((value) => { if (current) setCatalogDev(value); })
      .catch((error: unknown) => {
        if (current) setCatalogInputError(sanitizeDiagnosticText(
          error instanceof Error ? error.message : String(error), [], [catalogInput],
        ));
      })
      .finally(() => { if (current) setCatalogLoading(false); });
    return () => { current = false; };
  }, [props.controller, route.name, route.name === 'catalogDev' ? route.step : '']);
  useEffect(() => {
    if (route.name !== 'catalogStore') return;
    let current = true;
    setCatalogLoading(true);
    setCatalogInputError(undefined);
    void props.controller.getCatalogStoreManagement()
      .then((value) => { if (current) setCatalogStore(value); })
      .catch((error: unknown) => {
        if (current) setCatalogInputError(sanitizeDiagnosticText(
          error instanceof Error ? error.message : String(error), [], [],
        ));
      })
      .finally(() => { if (current) setCatalogLoading(false); });
    return () => { current = false; };
  }, [props.controller, route.name]);
  useEffect(() => {
    if (route.name !== 'catalogPublish' || route.step !== 'overview') return;
    let current = true;
    setCatalogLoading(true);
    setCatalogInputError(undefined);
    void props.controller.getCatalogPublicationManagement()
      .then((value) => { if (current) setCatalogPublication(value); })
      .catch((error: unknown) => {
        if (current) setCatalogInputError(sanitizeDiagnosticText(
          error instanceof Error ? error.message : String(error), [], [catalogPublishDraft.target],
        ));
      })
      .finally(() => { if (current) setCatalogLoading(false); });
    return () => { current = false; };
  }, [props.controller, route.name, route.name === 'catalogPublish' ? route.step : '']);
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
  const configRoute = route.name === 'configFields'
    || route.name === 'configFieldEditor'
    || route.name === 'configObjectPropertyEditor'
    || route.name === 'configFieldAction'
    || route.name === 'configSave'
    ? route
    : undefined;
  const configRouteOwner = configRoute ? configOwnerKey(configRoute) : undefined;
  useEffect(() => {
    const previous = previousExternalDraftValues.current;
    if (previous.draftUpdates !== draftUpdates
      || previous.draftRemoves !== draftRemoves
      || previous.objectDrafts !== objectDrafts
      || previous.changedObjectDraftKeys !== changedObjectDraftKeys) {
      externalDraftRevision.current.config += 1;
    }
    if (previous.sourceDraft !== sourceDraft) externalDraftRevision.current.source += 1;
    if (previous.batchDraft !== batchDraft) externalDraftRevision.current.batch += 1;
    if (previous.catalogInput !== catalogInput
      || previous.catalogWorkspaceDraft !== catalogWorkspaceDraft
      || previous.catalogPublishDraft !== catalogPublishDraft
      || previous.catalogDevSourceId !== catalogDevSourceId) externalDraftRevision.current.catalog += 1;
    previousExternalDraftValues.current = {
      draftUpdates, draftRemoves, objectDrafts, changedObjectDraftKeys, sourceDraft, batchDraft,
      catalogInput, catalogWorkspaceDraft, catalogPublishDraft, catalogDevSourceId,
    };
    const currentFlowId = snapshot.router.currentFlowId;
    if (currentFlowId && configRouteOwner) {
      externalDraftFlowIds.current.set(configRouteOwner, currentFlowId);
    }
    if (currentFlowId && sourceDraft) externalDraftFlowIds.current.set(sourceDraft.owner, currentFlowId);
    const drafts: ExternalDraftState[] = [];
    if ((dirty || changedObjectDraftKeys.length > 0) && draftOwner) {
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
    const catalogWorkspaceDirty = catalogWorkspaceDraft.ownerName !== ''
      || catalogWorkspaceDraft.ownerUrl !== '' || catalogWorkspaceDraft.displayName !== '';
    const catalogPublishDirty = catalogPublishDraft.target !== '';
    const catalogDraftActive = route.name === 'catalogWorkspace'
      && (route.view === 'create' || route.view === 'version' && route.step === 'catalogVersion')
      || route.name === 'catalogPublish' && route.step !== 'overview'
      || route.name === 'catalogDev' && route.step !== undefined && route.step !== 'overview'
      || route.name === 'catalogWorkspace' && route.view === 'overview' && catalogWorkspaceDirty
      || route.name === 'catalogPublish' && route.step === 'overview' && catalogPublishDirty;
    if (catalogDraftActive) drafts.push({
      kind: 'catalogDraft', owner: 'catalog-management', revision: externalDraftRevision.current.catalog,
    });
    props.controller.setExternalDraftState(drafts);
  }, [
    props.controller, batchDraft, changedObjectDraftKeys, configRouteOwner, dirty, draftOwner,
    draftRemoves, draftUpdates, objectDrafts, snapshot.router.currentFlowId, sourceDraft,
    catalogInput, catalogWorkspaceDraft, catalogPublishDraft, catalogDevSourceId, route.name,
    route.name === 'catalogWorkspace' ? `${route.view}:${route.step ?? ''}` : '',
    route.name === 'catalogPublish' || route.name === 'catalogDev' ? route.step : '',
  ]);
  useEffect(() => () => props.controller.setExternalDraftState(), [props.controller]);
  const currentConfigPage = configPageMatches(configPage, configRoute) ? configPage : undefined;
  const configDraftIssues = (() => {
    if (!configRoute || !currentConfigPage) return [];
    const fields = new Map(currentConfigPage.groups.flatMap((group) => group.fields)
      .map((field) => [field.key, field]));
    const issues: ConfigDraftIssue[] = [];
    for (const [key, value] of Object.entries(draftUpdates)) {
      const field = fields.get(key);
      if (!field || !configFieldCanSet(field)
        || validatePluginConfigValue(field.definition, value, key).length > 0) {
        issues.push({ key, source: 'update' });
      }
    }
    for (const key of draftRemoves) {
      const field = fields.get(key);
      if (!field || !configFieldCanUnset(field)) issues.push({ key, source: 'remove' });
    }
    const owner = `${configOwnerKey(configRoute)}\0`;
    for (const objectKey of changedObjectDraftKeys) {
      if (!objectKey.startsWith(owner)) continue;
      const key = objectKey.slice(owner.length);
      if (issues.some((issue) => issue.key === key)) continue;
      const field = fields.get(key);
      const value = objectDrafts[objectKey];
      if (!field || !configFieldCanSet(field) || field.definition.type !== 'object' || !value
        || validatePluginConfigValue(field.definition, value, key).length > 0) {
        issues.push({ key, source: 'object' });
      }
    }
    return issues;
  })();
  useEffect(() => {
    if (route.name !== 'configLayer') return;
    const abort = new AbortController();
    setConfigLayerPages({});
    const layers = [
      { key: 'user', layer: { scope: 'user' as const } },
      { key: 'project', layer: { scope: 'project' as const } },
    ];
    void Promise.allSettled(layers.map(async ({ key, layer }) => ({
      key,
      page: await props.controller.getConfigPage(route.pluginId, layer, abort.signal),
    }))).then((results) => {
      if (abort.signal.aborted) return;
      setConfigLayerCounts(Object.fromEntries(results.flatMap((result) =>
        result.status === 'fulfilled' ? [[result.value.key, result.value.page.storedCount]] : [])));
      setConfigLayerPages(Object.fromEntries(results.flatMap((result) =>
        result.status === 'fulfilled' ? [[result.value.key, result.value.page]] : [])));
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
      setObjectDrafts({});
      setChangedObjectDraftKeys([]);
      setObjectError(undefined);
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
          props.controller.replace({
            name: 'configUnavailable',
            pluginId: expectedPluginId,
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
    if (route.name === 'sourceList') count = props.controller.listSources().length + 3;
    else if (route.name === 'issueList') {
      const issueCount = props.controller.listUserIssues().length;
      count = issueCount || 2;
    } else if (route.name === 'operationHistory') {
      count = snapshot.operationHistorySummaries.length + 1;
    } else if (route.name === 'pluginList') {
      const itemCount = props.controller.listPlugins({
        mode: route.mode,
        ...(route.sourceId ? { sourceId: route.sourceId } : {}),
        ...(query ? { query } : {}),
        installFilter,
      }).length;
      const listed = new Set(props.controller.listPlugins({
        mode: route.mode,
        ...(route.sourceId ? { sourceId: route.sourceId } : {}),
        ...(query ? { query } : {}),
        installFilter,
      }).map((item) => item.pluginId));
      const menuCount = itemCount > 0 && !query ? 1
        + Number(route.mode === 'installed' && props.controller.listPluginWriteTaskCandidates('update')
          .some((candidate) => candidate.eligible && listed.has(candidate.target.pluginId)))
        + Number(route.mode === 'installed' && props.controller.listCurrentProjectIntentRoots().length > 0)
        + Number(route.mode === 'installed' && props.controller.listPluginWriteTaskCandidates('restore')
          .some((candidate) => candidate.target.scope === 'project')) : 0;
      count = itemCount + menuCount || 1;
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
    if (route.name !== 'operationReportPreview') return;
    setScrollOffset(0);
  }, [route.name, route.name === 'operationReportPreview' ? route.recordId : '']);
  useEffect(() => {
    if (route.name !== 'pluginDependencies') return;
    const direction = route.direction ?? 'dependencies';
    const key = dependencyGraphContextKey(route.pluginId, direction);
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
    const projection = buildDependencyGraphProjection({
      overviews,
      rootPluginId: route.pluginId,
      direction,
      ...(expandedPluginIds ? { expandedPluginIds } : {}),
    });
    const actionIds = dependencyGraphActionIds(projection);
    const normalizedExpanded = expandedPluginIds ?? new Set(projection.defaultExpandedPluginIds);
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
    route.name === 'pluginDependencies' ? route.direction ?? 'dependencies' : '',
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
    const listed = new Set(items.map((item) => item.pluginId));
    const menuCount = query ? 0 : 1
      + Number(route.mode === 'installed' && props.controller.listPluginWriteTaskCandidates('update')
        .some((candidate) => candidate.eligible && listed.has(candidate.target.pluginId)))
      + Number(route.mode === 'installed' && props.controller.listCurrentProjectIntentRoots().length > 0)
      + Number(route.mode === 'installed' && props.controller.listPluginWriteTaskCandidates('restore')
        .some((candidate) => candidate.target.scope === 'project'));
    setFocus(menuCount);
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
  const objectValueFromField = activeField?.draftValue !== null
    && typeof activeField?.draftValue === 'object'
    && !Array.isArray(activeField.draftValue)
    ? activeField.draftValue as PluginConfigObject
    : undefined;
  const activeObjectDraft = activeObjectKey
    ? objectDrafts[activeObjectKey] ?? objectValueFromUpdate ?? objectValueFromField ?? {}
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
    const draft = draftUpdates[activeField.key];
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
  const supportsTechnicalDetails = snapshot.phase === 'error'
    || Boolean(route.name === 'reviewPreparing' && snapshot.reviewPreparation?.code)
    || Boolean(route.name === 'progress' && snapshot.progress.messages.length > 0)
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
  const actionViewportStaticRows = route.name === 'dependencyPlacement'
    ? dependencyPlacementStaticRows
    : route.name === 'operationHistory' ? 4
      : route.name === 'operationReportPreview' ? 5 : 0;
  const responsiveBudget = (compactRows: number, standardRows: number): number => {
    const baseline = policy.mode === 'compact' ? 18 : 24;
    const base = policy.mode === 'compact' ? compactRows : standardRows;
    return base + Math.max(0, size.rows - baseline);
  };
  const pluginListMenuCount = (
    mode: 'browse' | 'installed',
    items: PluginListItemViewModel[],
    queryValue = query,
  ): number => {
    if (items.length === 0 || queryValue) return 0;
    const listed = new Set(items.map((item) => item.pluginId));
    return 1
      + Number(mode === 'installed' && props.controller.listPluginWriteTaskCandidates('update')
        .some((candidate) => candidate.eligible && listed.has(candidate.target.pluginId)))
      + Number(mode === 'installed' && props.controller.listCurrentProjectIntentRoots().length > 0)
      + Number(mode === 'installed' && props.controller.listPluginWriteTaskCandidates('restore')
        .some((candidate) => candidate.target.scope === 'project'));
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
    setScrollOffset(0);
    setSearchFocus(false);
    setShowTechnical(false);
    setActionError(undefined);
  };
  const toggleTechnical = (): void => {
    setShowTechnical((value) => !value);
    setBatchTargetOffset(0);
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
      itemCount = items.length;
      const entityIndex = restored.focusedEntityId
        ? items.findIndex((item) => item.pluginId === restored.focusedEntityId)
        : -1;
      restoredFocus = entityIndex >= 0
        ? pluginListMenuCount(restoredFrame.route.mode, items, restored.query ?? '') + entityIndex
        : Math.min(restoredFocus, Math.max(0,
            pluginListMenuCount(restoredFrame.route.mode, items, restored.query ?? '') + items.length - 1));
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
    const supportsScriptTimeout = intent.kind === 'pluginWrite'
      && (intent.action === 'install' || intent.action === 'sync'
        || intent.action === 'refreshAndSync' || intent.action === 'reinstall')
      || intent.kind === 'pluginWriteBatch'
        && (intent.action === 'install' || intent.action === 'sync' || intent.action === 'reinstall')
      || intent.kind === 'pluginWriteTask'
      || intent.kind === 'configSave' && intent.apply;
    const pendingIntent = supportsScriptTimeout ? intent : undefined;
    pendingReviewIntentRef.current = pendingIntent;
    setPendingReviewIntent(pendingIntent);
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
    setFocus(1);
    setScrollOffset(0);
    setSearchFocus(false);
  };
  const batchCandidates = (draft: BatchDraft): BatchSelectionCandidate[] => {
    const mode = draft.mode;
    const all = props.controller.listPlugins({ mode });
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
    }).map((plugin) => ({ pluginId: plugin.pluginId, plugin }));
  };
  const batchCandidateBlockReason = (
    draft: BatchDraft,
    candidate: BatchSelectionCandidate,
  ): string | undefined => !candidate.plugin
    ? '插件已不在当前状态中，可取消选择'
    : candidate.plugin.configOnly
    ? '来源中没有可信插件定义'
    : draft.mode === 'browse' && hasInstalledPlacement(candidate.plugin)
      ? '这个插件已经添加'
      : undefined;
  const invalidBatchSelection = (draft: BatchDraft): string[] => {
    const byId = new Map(props.controller.listPlugins({ mode: draft.mode })
      .map((plugin) => [plugin.pluginId, plugin]));
    return draft.selectedPluginIds.filter((pluginId) => batchCandidateBlockReason(draft, {
      pluginId,
      ...(byId.get(pluginId) ? { plugin: byId.get(pluginId) } : {}),
    }) !== undefined);
  };
  const persistDependencyGraphContext = (
    graphRoute: Extract<TuiRoute, { name: 'pluginDependencies' }>,
    projection: ReturnType<typeof buildDependencyGraphProjection>,
    expandedPluginIds: ReadonlySet<string>,
    focusIndex: number,
    offset: number,
  ): void => {
    const direction = graphRoute.direction ?? 'dependencies';
    const actionIds = dependencyGraphActionIds(projection);
    dependencyGraphContexts.current.set(
      dependencyGraphContextKey(graphRoute.pluginId, direction),
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
          })) }
        : {}),
    });
  };
  const continueInstallAfterTargets = async (
    candidate: PluginListItemViewModel,
    targets: PlatformName[],
  ): Promise<void> => {
    if (props.controller.snapshot.installPlacementDraft?.pluginId !== candidate.pluginId) {
      props.controller.beginInstallFlow(candidate.pluginId, scope);
    }
    props.controller.setInstallPlatforms(targets);
    await props.controller.prepareInstallDependencyPlacement();
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
      setActionError('当前没有可安全确认的受限清理目标。共享、外来、符号链接和原生内容会保持不变。');
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
    if (!pluginId || !selectedIssue.platform) return undefined;
    const selectedScope = action.id === 'keepUserScope'
      ? 'project'
      : action.id === 'keepProjectScope' ? 'user' : action.scope ?? selectedIssue.scope;
    const selectedPlatform = action.platform ?? selectedIssue.platform;
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
        { title: 'Catalog 子目录', before: current?.type === 'git' ? current.subdir ?? '未设置' : undefined, after: draft.subdir || '未设置', changed: current?.type !== 'git' || (current.subdir ?? '') !== draft.subdir },
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
  const fieldEditor = (field: ConfigFieldViewModel): Extract<TuiRoute, { name: 'configFieldEditor' }>['editor'] => {
    return field.type;
  };
  const fieldEditorMode = (field: ConfigFieldViewModel): { mode: 'choices' } | Record<string, never> =>
    (field.choices?.length ?? 0) > 0 ? { mode: 'choices' } : {};
  const updateDraft = (key: string, value: PluginConfigValue): void => {
    setConfigActionError(undefined);
    const field = currentConfigPage?.groups.flatMap((group) => group.fields)
      .find((candidate) => candidate.key === key);
    const unchanged = field?.configured === true
      && configValuesEqual(field.draftValue ?? field.value, value);
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
    back();
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
      layer: { scope: configRoute!.layer.scope as Scope },
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
    setDraftUpdates((current) => {
      const next = { ...current };
      for (const [key, value] of Object.entries(preset.values)) {
        const field = fields.get(key);
        if (!field?.writable) continue;
        if (field?.configured && configValuesEqual(field.draftValue ?? field.value, value)) delete next[key];
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
    layer: { scope: Scope },
  ): void => {
    if (route.name !== 'configLayer') return;
    const definitionPage = configPage ?? configLayerPages.user ?? configLayerPages.project;
    const field = route.fieldKey && definitionPage
      ? definitionPage.groups.flatMap((group) => group.fields).find((candidate) => candidate.key === route.fieldKey)
      : undefined;
    const fieldTarget = definitionPage ? configFieldTarget(definitionPage, route.fieldKey) : undefined;
    const preset = route.presetId && definitionPage
      ? definitionPage.presets.find((candidate) => candidate.id === route.presetId)
      : undefined;
    const presetTarget = preset
      ? configFieldTarget(definitionPage!, Object.keys(preset.values)[0])
      : undefined;
    const target = fieldTarget ?? (route.groupId ? { groupId: route.groupId, focusIndex: 0 } : undefined) ?? presetTarget
      ?? (definitionPage?.groups[0] ? { groupId: definitionPage.groups[0].id, focusIndex: 0 } : undefined);
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
        const beforeObject = field?.definition.type === 'object'
          && typeof field.draftValue === 'object' ? field.draftValue : undefined;
        const updatedValue = draftUpdates[key];
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
        const children = draftRemoves.includes(key)
          ? field.fallbackObjectChanges
          : updatedChildren;
        return {
          key,
          title: field?.title ?? key,
          before: field?.displayValue ?? '未设置',
          after: draftRemoves.includes(key)
            ? `恢复继承（${field?.fallbackDisplayValue ?? '未设置'} · ${field?.fallbackSourceLabel ?? '未设置'}）`
            : currentFieldDisplay(field),
          ...(children && children.length > 0 ? { children } : {}),
        };
      });
  };
  const discardInvalidConfigDraftChanges = (): void => {
    if (!configRoute || configDraftIssues.length === 0) return;
    const invalidKeys = new Set(configDraftIssues.map((issue) => issue.key));
    const nextUpdates = Object.fromEntries(Object.entries(draftUpdates)
      .filter(([key]) => !invalidKeys.has(key)));
    const nextRemoves = draftRemoves.filter((key) => !invalidKeys.has(key));
    const owner = `${configOwnerKey(configRoute)}\0`;
    const nextChangedObjectKeys = changedObjectDraftKeys.filter((key) => !key.startsWith(owner)
      || !invalidKeys.has(key.slice(owner.length)));
    setDraftUpdates(nextUpdates);
    setDraftRemoves(nextRemoves);
    setObjectDrafts((current) => Object.fromEntries(Object.entries(current)
      .filter(([key]) => !key.startsWith(owner)
        || !invalidKeys.has(key.slice(owner.length)))));
    setChangedObjectDraftKeys(nextChangedObjectKeys);
    setDirty(Object.keys(nextUpdates).length + nextRemoves.length + nextChangedObjectKeys.length > 0);
    setObjectError(undefined);
    setConfigActionError(undefined);
  };
  const configSaveIntent = (
    apply: boolean,
  ): Extract<OperationIntent, { kind: 'configSave' }> | undefined => {
    if (!configRoute || configRoute.layer.scope === 'effective' || !currentConfigPage || !dirty) return;
    const fields = currentConfigPage.groups.flatMap((group) => group.fields);
    return {
      kind: 'configSave',
      pluginId: configRoute.pluginId,
      scope: configRoute.layer.scope,
      apply,
      updates: draftUpdates,
      removeKeys: draftRemoves,
      sensitiveKeys: fields.filter((field) => field.sensitive).map((field) => field.key),
      privateKeys: fields.filter((field) => configObjectHasSensitiveChild(field.definition))
        .map((field) => field.key),
      changes: configChanges(),
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
    if (!pendingLayerFieldKey || route.name !== 'configFields'
      || route.layer.scope === 'effective' || !currentConfigPage) return;
    const field = currentConfigPage.groups.flatMap((group) => group.fields)
      .find((candidate) => candidate.key === pendingLayerFieldKey);
    setPendingLayerFieldKey(undefined);
    if (!field || (!configFieldCanSet(field) && !configFieldCanUnset(field))) return;
    const layer = { scope: route.layer.scope as Scope };
    props.controller.push(field.configured || !configFieldCanSet(field) ? {
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
      ...fieldEditorMode(field),
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
  useEffect(() => {
    if (route.name !== 'configSave') {
      setConfigSaveImpact(undefined);
      setConfigSaveImpactError(false);
      return;
    }
    const intent = configSaveIntent(false);
    if (!intent) return;
    const abort = new AbortController();
    setConfigSaveImpact(undefined);
    setConfigSaveImpactError(false);
    void props.controller.previewConfigSaveImpact(intent, abort.signal)
      .then((impact) => {
        if (!abort.signal.aborted) setConfigSaveImpact(impact);
      })
      .catch(() => {
        if (!abort.signal.aborted) setConfigSaveImpactError(true);
      });
    return () => abort.abort();
  }, [
    props.controller,
    route.name,
    route.name === 'configSave' ? `${route.pluginId}:${route.layer.scope}` : '',
    draftRemoves,
    draftUpdates,
  ]);

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
    context = '当前项目';
    actions = [
      { label: '添加插件', description: '浏览多个来源中的 Agent 能力', meta: String(home.availablePlugins), run: () => go({ name: 'pluginList', mode: 'browse' }) },
      { label: '我的插件', description: '查看状态、设置和移除已添加插件', meta: home.pluginUpdateCount > 0 ? `${home.installedPlugins} · ${home.pluginUpdateCount} 可更新` : String(home.installedPlugins), status: home.pluginUpdateCount > 0 ? 'warning' : undefined, run: () => go({ name: 'pluginList', mode: 'installed' }) },
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
    content = <Box flexDirection="column">
      <StatusCard
        status={home.issueCount > 0 || home.unavailableSourceCount > 0 ? 'warning' : 'success'}
        title="当前状态"
      >
        {snapshot.statusReadAtMs !== undefined
          ? <StaticRow title="最近成功读取状态" meta={new Date(snapshot.statusReadAtMs).toLocaleString('zh-CN', { hour12: false })} compact />
          : null}
        <ResultRow title={`${home.installedPlugins} 个插件可用`} status="success" />
        <ResultRow title={`${home.issueCount} 项需要处理`} status={home.issueCount > 0 ? 'warning' : 'muted'} />
        {home.unavailableSourceCount > 0 ? <ResultRow title={`${home.unavailableSourceCount} 个来源不可用`} status="error" /> : null}
        {home.catalogCheckingCount > 0 ? <ResultRow title={`${home.catalogCheckingCount} 个插件来源正在检查`} status="muted" /> : null}
        {home.catalogUpdateCount > 0 ? <ResultRow title={`${home.catalogUpdateCount} 个插件来源有更新`} status="warning" /> : null}
        {home.pluginUpdateCount > 0 ? <ResultRow title={`${home.pluginUpdateCount} 个插件可更新${home.directPluginUpdateCount < home.pluginUpdateCount ? `；${home.directPluginUpdateCount} 个可直接确认` : ''}`} status="warning" /> : null}
        {home.catalogRecoveryCount > 0 ? <ResultRow title={`${home.catalogRecoveryCount} 个插件来源需要检查或恢复`} status="warning" /> : null}
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
    const updateCount = props.controller.listPlugins({
      mode: route.mode,
      ...(sourceId !== 'all' ? { sourceId } : {}),
      ...(query ? { query } : {}),
      installFilter: 'updateAvailable',
    }).length;
    breadcrumb = route.mode === 'browse' ? '添加插件' : '我的插件';
    title = breadcrumb;
    description = route.mode === 'browse'
      ? '选择一个插件，或从列表前部选择多个。'
      : '先处理推荐任务，或查看一个插件。';
    context = `${items.length} 个插件`;
    help = `↑↓ 移动 · Enter 查看 · m 批量${route.mode === 'installed' ? ' · a 按项目清单准备 · f 可更新' : ''} · ←→ 来源 · / 搜索${route.mode === 'browse' ? ' · f 未安装' : ''} · Esc 返回`;
    const sourceError = sourceId !== 'all'
      && props.controller.getSourceOverview(sourceId).health?.state === 'unavailable';
    actions = sourceError
      ? [{ label: '查看来源问题', description: '当前不能浏览这个来源', run: () => go({ name: 'issueDetail', issueId: `source:${sourceId}:unavailable` }) }]
      : [];
    const listedPluginIds = new Set(items.map((item) => item.pluginId));
    const recommendedUpdateCandidates = props.controller.listPluginWriteTaskCandidates('update')
      .filter((candidate) => candidate.eligible && listedPluginIds.has(candidate.target.pluginId));
    const recommendedUpdatePluginIds = [...new Set(recommendedUpdateCandidates
      .map((candidate) => candidate.target.pluginId))];
    const projectRestoreCandidates = props.controller.listPluginWriteTaskCandidates('restore')
      .filter((candidate) => candidate.target.scope === 'project');
    const projectIntentRoots = props.controller.listCurrentProjectIntentRoots();
    const menuRows: PluginListRowViewModel[] = sourceError || items.length === 0 || query ? [] : [
      ...(route.mode === 'installed' && recommendedUpdatePluginIds.length > 0 ? [{
        pluginId: '@menu:update',
        name: `更新 ${recommendedUpdatePluginIds.length} 个插件…`,
        sourceLabel: '',
        description: '使用已验证版本和现有安装位置，直接查看任务确认',
        placementSummary: '',
        statusLabel: '推荐',
        status: 'warning' as const,
        menuAction: () => openSelectedPluginTask('update', recommendedUpdatePluginIds),
      }] : []),
      ...(route.mode === 'installed' && projectIntentRoots.length > 0 ? [{
        pluginId: '@menu:restore-project',
        name: '按项目清单准备…',
        sourceLabel: '',
        description: `${projectIntentRoots.length} 个已保存根插件；允许补齐当前项目缺少的安装`,
        placementSummary: '',
        statusLabel: '项目',
        status: 'info' as const,
        menuAction: prepareCurrentProjectPlugins,
      }] : []),
      ...(route.mode === 'installed' && projectRestoreCandidates.length > 0 ? [{
        pluginId: '@menu:repair-project',
        name: '修复本项目异常…',
        sourceLabel: '',
        description: '严格按已确认的现有版本修复异常，不改变插件版本',
        placementSummary: '',
        statusLabel: '推荐',
        status: 'warning' as const,
        menuAction: () => openSelectedPluginTask('restore', [...new Set(projectRestoreCandidates
          .map((candidate) => candidate.target.pluginId))], 'project'),
      }] : []),
      {
        pluginId: '@menu:batch',
        name: route.mode === 'browse' ? '选择多个插件添加…' : '选择多个…',
        sourceLabel: '',
        description: route.mode === 'browse'
          ? '先选择插件，再选择安装位置和平台'
          : '先选择插件，再选择更新、恢复、移除或维护任务',
        placementSummary: '',
        statusLabel: '菜单',
        status: 'info' as const,
        menuAction: () => openBatchSelection(route.mode === 'browse' ? 'install' : undefined),
      },
    ];
    pluginRows = sourceError ? [] : [...menuRows, ...items.map((item) => ({
      pluginId: item.pluginId,
      name: item.displayName,
      sourceLabel: item.sourceLabel,
      description: item.configOnly
        ? '来源当前没有这个插件；可以查看已保存设置或定点重置设置层。'
        : item.description,
      ...(item.primaryAttention ? { attention: item.primaryAttention.message } : {}),
      placementSummary: pluginPlacementSummary(item),
      statusLabel: statusText(item),
      status: pluginRowStatus(item),
    }))];
    if (route.mode === 'installed' && installFilter === 'updateAvailable'
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
    } else if (route.mode === 'installed' && items.length === 0 && !sourceError) {
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
    const pluginListStaticRows = 3;
    const viewport = sourceError || pluginRows.length === 0
      ? actionViewport(actions, policy.mode === 'compact', focus, scrollOffset, pageActionBudget(pluginListStaticRows))
      : rowViewport({
          rowHeights: pluginRows.map((row) => row.menuAction
            ? 1
            : row.attention ? 4 : 3),
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
          : <Text color={tuiTheme.colors.muted}>状态  <Text color={installFilter === 'all' ? tuiTheme.colors.accent : tuiTheme.colors.muted}>{installFilter === 'all' ? '[全部]' : '全部'}</Text>  <Text color={installFilter === 'updateAvailable' ? tuiTheme.colors.accent : tuiTheme.colors.muted}>{installFilter === 'updateAvailable' ? '[可更新]' : '可更新'} {updateCount}</Text>                         f 切换</Text>}
        {sourceError
          ? <Callout status="error" title={`${sourceId} 暂时无法提供插件`} description="当前不能浏览这个来源。" />
          : route.mode === 'installed' && items.length === 0
            ? installFilter === 'updateAvailable'
              ? <Callout title="没有可更新插件" description="当前筛选范围内没有经过版本证据确认的更新。" />
              : <Callout title="开始添加第一个插件" description="插件可以安装到 Codex、Claude Code 或两者。" />
            : null}
        {pluginRows.length > 0
          ? <PluginRows rows={pluginRows} focus={focus} viewport={viewport} />
          : <SemanticRows actions={actions} focus={focus} kind="action" compact={policy.mode === 'compact'} offset={viewport.offset} limit={viewport.limit} />}
      </Box>
    );
  } else if (route.name === 'batchSelection') {
    breadcrumb = `${batchDraft?.mode === 'browse' ? '添加插件' : '我的插件'} / 选择多个`;
    title = batchDraft?.stage === 'task' ? `为 ${batchDraft.selectedPluginIds.length} 个插件选择任务`
      : batchDraft?.stage === 'maintenance' ? '其他维护方式'
        : batchDraft?.mode === 'browse' ? '选择要添加的插件' : '选择插件';
    description = batchDraft?.stage === 'select'
      ? 'Space 切换选择，Enter 查看插件。选择会跨来源、搜索和筛选保留。'
      : batchDraft?.stage === 'task'
        ? '更新和恢复使用现有精确位置；移除会明确使用已有位置。'
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
        return {
          label: candidate.plugin?.displayName ?? `${candidate.pluginId}（已不可用，可取消选择）`,
          description: blockReason
            ? `${candidate.plugin?.sourceLabel ?? '状态已失效'} · ${isSelected ? '可取消选择' : '不可选择'}：${blockReason}`
            : `${candidate.plugin!.sourceLabel} · ${pluginPlacementSummary(candidate.plugin!)}`,
          selected: isSelected,
          pluginId: candidate.pluginId,
          canSelectNew: blockReason === undefined,
          status: blockReason ? 'muted' : undefined,
          run: candidate.plugin ? () => go(batchDraft.mode === 'browse'
            ? { name: 'pluginPreview', pluginId: candidate.pluginId }
            : { name: 'pluginDetail', pluginId: candidate.pluginId }) : undefined,
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
        if (batchDraft.mode === 'browse') {
          setBatchDraft((current) => current ? { ...current, action: 'install' } : current);
          props.controller.push({ name: 'batchPlacement' });
        } else {
          setBatchDraft((current) => current ? { ...current, stage: 'task' } : current);
        }
        setFocus(0);
        setScrollOffset(0);
      };
      const continueAction: ActionItem = {
        label: `查看确认（${batchDraft.selectedPluginIds.length}）`,
        description: batchDraft.selectedPluginIds.length > 0 ? '继续选择任务和确认范围' : '先选择至少一个插件',
        run: continueSelection,
      };
      const utilityActions: ActionItem[] = [
        {
          label: batchDraft.showSelected ? '返回当前结果' : `查看全部已选（${batchDraft.selectedPluginIds.length}）`,
          description: hiddenSelected > 0 ? `${hiddenSelected} 个选择在其他筛选中` : '完整 canonical 选择集合',
          run: () => {
            setBatchDraft((current) => current ? { ...current, showSelected: !current.showSelected } : current);
            setFocus(0);
            setScrollOffset(0);
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
      actions = [continueAction, ...candidateActions, ...utilityActions];
      const batchFocus = Math.min(focus, actions.length - 1);
      context = `已选 ${batchDraft.selectedPluginIds.length} 个 · 显示 ${candidates.length} 个${hiddenSelected > 0 ? ` · 隐藏 ${hiddenSelected} 个` : ''}`;
      help = '↑↓ 移动 · Space 选择 · Enter 查看/操作 · c 查看确认 · ←→ 来源 · / 搜索 · Esc 放弃';
      const scrollActions = [...candidateActions, ...utilityActions];
      const viewport = actionViewport(scrollActions, policy.mode === 'compact', Math.max(0, batchFocus - 1),
        Math.max(0, scrollOffset - 1), Math.max(1, pageActionBudget(5)));
      const focusedCandidate = batchFocus > 0 && batchFocus <= candidateActions.length
        ? candidates[batchFocus - 1]?.plugin : undefined;
      content = <Box flexDirection="column">
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
        <SemanticRows actions={[continueAction]} focus={batchFocus} kind="action" compact />
        {focusedCandidate
          ? <StaticRow title={`用途 · ${focusedCandidate.description}`} status="info" compact />
          : null}
        <SemanticRows actions={scrollActions} focus={batchFocus - 1} kind="toggle"
          compact={policy.mode === 'compact'} offset={viewport.offset} limit={viewport.limit} />
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
          { label: '同步已保存使用设置…', description: `重新应用 ${syncTargets.length} 个已保存或现场目标`, run: () => startExistingBatch('sync') },
          { label: '重新安装…', description: `重新生成 ${props.controller.listPluginWriteBatchTargets('reinstall', selectedIds).length} 个已保存或现场目标`, run: () => startExistingBatch('reinstall') },
          { label: '清理遗留内容…', description: `${props.controller.listPluginWriteBatchTargets('cleanup', selectedIds).length} 个有受管证据的位置；保留 foreign 和 shared 内容`, run: () => startExistingBatch('cleanup') },
          {
            label: '返回任务选择',
            run: () => {
              setBatchDraft((current) => current ? { ...current, stage: 'task' } : current);
              setFocus(0);
              setScrollOffset(0);
            },
          },
        ];
      } else {
        const updates = taskCandidates('update');
        const restores = taskCandidates('restore');
        const updateRoots = new Set(updates.map((candidate) => candidate.target.pluginId)).size;
        const restoreRoots = new Set(restores.map((candidate) => candidate.target.pluginId)).size;
        actions = [
          ...(updates.length > 0 ? [{
            label: `更新所选中的 ${updateRoots} 个可更新插件…`,
            description: '使用已验证版本和现有精确位置',
            status: 'warning' as const,
            run: () => openSelectedPluginTask('update', selectedIds),
          }] : []),
          ...(restores.length > 0 ? [{
            label: `恢复所选中的 ${restoreRoots} 个插件…`,
            description: '按当前问题和现有精确位置准备方案',
            status: 'warning' as const,
            run: () => openSelectedPluginTask('restore', selectedIds),
          }] : []),
          { label: '移除所选插件…', description: `${uninstallTargets.length} 个现场目标；执行前检查所有权；保留设置`, status: 'error', run: () => startExistingBatch('uninstall') },
          {
            label: '其他维护方式…',
            description: '同步、重新安装和普通清理',
            run: () => {
              setBatchDraft((current) => current ? { ...current, stage: 'maintenance' } : current);
              setFocus(0);
              setScrollOffset(0);
            },
          },
          { label: '返回调整选择', run: () => setBatchDraft((current) => current ? { ...current, stage: 'select' } : current) },
        ];
      }
      context = `${selectedIds.length} 个插件 · ${syncTargets.length} 个已保存或现场目标`;
      help = '↑↓ 移动 · Enter 选择 · Esc 返回修改';
      const viewport = actionViewport(actions, policy.mode === 'compact', focus, scrollOffset, pageActionBudget(1));
      content = <SemanticRows actions={actions} focus={focus} kind="task" compact={policy.mode === 'compact'} offset={viewport.offset} limit={viewport.limit} />;
    }
  } else if (route.name === 'batchPlacement') {
    breadcrumb = '我的插件 / 批量操作 / 位置';
    title = batchDraft?.selection === 'currentProjectIntentRoots'
      ? '同步当前项目全部保存目标'
      : `设置批量${batchDraft?.action ? batchActionLabel(batchDraft.action) : ''}位置`;
    description = '所有选择使用同一位置和平台。确认页会重新读取状态并冻结实际计划。';
    if (!batchDraft?.action) {
      actions = [{ label: '返回批量选择', run: back }];
    } else {
      const projectIntent = batchDraft.selection === 'currentProjectIntentRoots';
      actions = [
        {
          label: '当前项目', selected: batchDraft.scope === 'project',
          run: () => setBatchDraft((current) => current ? { ...current, scope: 'project' } : current),
        },
        {
          label: '所有项目', selected: batchDraft.scope === 'user',
          disabled: projectIntent ? '项目全部同步固定使用当前项目' : undefined,
          run: () => setBatchDraft((current) => current ? { ...current, scope: 'user' } : current),
        },
        ...(['codex', 'claude', 'both'] as const).map((platform) => ({
          label: platform === 'both' ? 'Codex 和 Claude Code' : platformLabel(platform),
          selected: batchDraft.platform === platform,
          run: () => setBatchDraft((current) => current ? { ...current, platform } : current),
        })),
        {
          label: `查看批量${batchActionLabel(batchDraft.action)}确认`,
          description: `${batchDraft.selection === 'selected' ? `${batchDraft.selectedPluginIds.length} 个所选插件` : '当前项目全部保存目标'} · ${scopeLabel(batchDraft.scope)}`,
          disabled: batchDraft.selection === 'selected' && batchDraft.selectedPluginIds.length === 0
            ? '请至少选择一个插件' : undefined,
          run: () => {
            if (invalidBatchSelection(batchDraft).length > 0) {
              setActionError('已选插件状态已变化。请返回选择页检查并取消失效项。');
              return;
            }
            const intent: OperationIntent = {
              kind: 'pluginWriteBatch',
              action: batchDraft.action!,
              selection: batchDraft.selection === 'selected'
                ? {
                    kind: 'selected',
                    pluginIds: [...new Set(batchDraft.selectedPluginIds)]
                      .sort((left, right) => left.localeCompare(right, 'en')),
                  }
                : { kind: 'currentProjectIntentRoots' },
              platform: batchDraft.platform,
              scope: batchDraft.scope,
            };
            beginReview(intent);
            setDirty(false);
            setFocus(0);
            setScrollOffset(0);
          },
        },
      ];
    }
    context = batchDraft?.selection === 'selected'
      ? `${batchDraft.selectedPluginIds.length} 个插件`
      : '保存的项目目标';
    help = '↑↓ 移动 · Enter 选择 · Esc 返回修改';
    content = <SemanticRows actions={actions} focus={focus} kind="choice" compact={policy.mode === 'compact'} />;
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
    const advancedPreviewActions = previewMenu.map(previewAction);
    const primaryPreviewAction = advancedPreviewActions[0] ?? {
      label: '查看处理建议',
      run: () => go({ name: 'pluginTechnical', pluginId: plugin.pluginId }),
    };
    const previewSettingsAction = previewMenu.findIndex((action) => action.id === 'settings');
    actions = [
      primaryPreviewAction,
      ...(previewSettingsAction > 0 ? [advancedPreviewActions[previewSettingsAction]!] : [{
        label: '使用说明',
        description: '查看用途、支持平台和来源',
        run: () => go({ name: 'pluginAbout', pluginId: plugin.pluginId }),
      }]),
      {
        label: '更多操作…',
        description: '安装方式、依赖、通用 Skills、来源和诊断',
        run: () => go({ name: 'pluginMore', pluginId: plugin.pluginId }),
      },
    ];
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
      { label: '指定 Agent…', description: '输入一个或多个 Agent ID', selected: snapshot.portableDraft.agentMode === 'explicit', run: () => go({ name: 'portableAgentInput', pluginId: plugin.pluginId }) },
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
    title = diagnostic.title;
    description = '';
    actions = [
      ...(route.code === 'requiredConfigMissing' ? [{ label: '完成插件设置', run: () => {
        props.controller.replace({ name: 'configLayer', pluginId: plugin.pluginId });
        setFocus(0);
        setScrollOffset(0);
      } }] : []),
      ...(route.code === 'portableSkillsCliMissing' || route.code === 'portableSkillsCliIncompatible'
        ? [{ label: showTechnical ? '返回问题摘要' : '查看安装说明', run: () => toggleTechnical() }]
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
        : [{ label: showTechnical ? '返回问题摘要' : '技术详情', run: () => toggleTechnical() }]),
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
    const dependentLimit = responsiveBudget(2, 4);
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
      actions = [
        { label: '查看完整依赖关系', run: () => {
          props.controller.replace({ name: 'pluginDependencies', pluginId: plugin.pluginId });
          setFocus(0);
          setScrollOffset(0);
        } },
        { label: '返回插件详情', run: back },
        { label: showTechnical ? '隐藏技术详情' : '技术详情', run: () => toggleTechnical() },
      ];
      const blockedRemovalViewport = actionViewport(actions, policy.mode === 'compact', focus, scrollOffset, pageActionBudget(5));
      if (!showTechnical && visibleDependents.length > dependentLimit) {
        help = 'PgUp/PgDn 查看全部被依赖关系 · ↑↓ 移动 · Enter 选择 · Esc 返回';
      }
      content = <Box flexDirection="column">
        <Callout status="error" title={`${dependentCount} 个已安装插件仍在使用`} description="没有修改任何安装。" />
        {showTechnical ? null : <SectionCard title="使用这个依赖的插件" meta="反向引用">
          {dependencyRows(visibleDependents, dependentLimit, true, batchTargetOffset)}
        </SectionCard>}
        <SemanticRows actions={actions} focus={focus} kind="action" compact={policy.mode === 'compact'} offset={blockedRemovalViewport.offset} limit={blockedRemovalViewport.limit} />
        {showTechnical ? <IssueTechnicalDetails details={[{
          code: 'dependencyStillRequired',
          message: '已安装插件仍在使用这个依赖；请先处理依赖者。',
        }]} compact={policy.mode === 'compact'} /> : null}
      </Box>;
    } else {
      breadcrumb = `${plugin.displayName} / 依赖关系`;
      const direction = route.direction ?? 'dependencies';
      const projection = buildDependencyGraphProjection({
        overviews: props.controller.listPluginDependencyOverviews(),
        rootPluginId: plugin.pluginId,
        direction,
        ...(expandedDependencyPluginIds ? { expandedPluginIds: expandedDependencyPluginIds } : {}),
      });
      const visibleRows = projection.rows;
      context = direction === 'dependencies' ? '它需要的' : '谁在使用它';
      title = hasInstalledPlacement(plugin) ? '依赖与被使用情况' : '安装所需插件';
      description = direction === 'dependencies'
        ? '当前方向：它需要的。缩进表示上一层需要它。'
        : '当前方向：谁在使用它。只显示已知的实际引用。';
      const rowActions: ActionItem[] = visibleRows.map((row) => {
        const state = row.depth === 0
          ? { value: statusText(plugin), status: plugin.aggregateStatus === 'needsAttention'
            ? 'warning' as const : plugin.aggregateStatus === 'unavailable' ? 'error' as const : 'success' as const }
          : dependencyGraphRowStatus(row);
        const branch = row.depth === 0 ? ''
          : `${row.ancestorHasNextSibling.map((next) => next ? '│ ' : '  ').join('')}${row.lastChild ? '└─' : '├─'} `;
        const compactBranch = policy.mode === 'compact' && row.depth > 2 ? '… └─ ' : branch;
        return {
          label: row.depth === 0
            ? `根插件 · ${row.label}（当前插件）`
            : `${compactBranch}${direction === 'dependencies' ? '必需依赖 · ' : '实际使用者 · '}${row.label}${row.sharedWithRowId ? ' ↗ [same]' : ''}`,
          description: row.hiddenDescendantCount > 0
            ? `另有 ${row.hiddenDescendantCount} 个${direction === 'dependencies' ? '所需插件' : '实际使用者'}`
            : row.depth === 0 ? '当前插件' : undefined,
          meta: state.value,
          status: state.status,
          run: () => {
            persistDependencyGraphContext(
              route,
              projection,
              expandedDependencyPluginIds ?? new Set(projection.defaultExpandedPluginIds),
              focus,
              scrollOffset,
            );
            go({
              name: 'pluginDependencyNode',
              pluginId: plugin.pluginId,
              nodePluginId: row.pluginId,
              direction,
            });
          },
        };
      });
      const unverifiedConsumerActions: ActionItem[] = direction === 'dependents'
        ? projection.scopeSummary.unknownConsumerPluginIds.map((pluginId) => {
            const declared = overview?.dependents.find((entry) => entry.pluginId === pluginId);
            return {
              label: `未验证声明者 · ${declared?.displayName ?? pluginId}`,
              description: '目录声明它依赖当前插件，但当前没有实际引用证据',
              meta: declared?.aggregateStatus === 'notInstalled' ? '未安装' : '未验证',
              status: 'muted' as const,
              run: () => {
                persistDependencyGraphContext(
                  route,
                  projection,
                  expandedDependencyPluginIds ?? new Set(projection.defaultExpandedPluginIds),
                  focus,
                  scrollOffset,
                );
                go({
                  name: 'pluginDependencyNode',
                  pluginId: plugin.pluginId,
                  nodePluginId: pluginId,
                  direction,
                });
              },
            };
          })
        : [];
      actions = [
        ...rowActions,
        ...unverifiedConsumerActions,
        {
          label: direction === 'dependencies' ? '切换到“谁在使用它”' : '切换到“它需要的”',
          description: '切换关系方向',
          run: () => {
            persistDependencyGraphContext(
              route,
              projection,
              expandedDependencyPluginIds ?? new Set(projection.defaultExpandedPluginIds),
              focus,
              scrollOffset,
            );
            props.controller.replace({
              name: 'pluginDependencies',
              pluginId: plugin.pluginId,
              direction: direction === 'dependencies' ? 'dependents' : 'dependencies',
            });
          },
        },
        { label: showTechnical ? '隐藏检查详情' : '查看检查详情', run: () => toggleTechnical() },
      ];
      const scopeText = projection.scopeSummary.references.length > 0
        ? projection.scopeSummary.references.map((entry) =>
            `${platformLabel(entry.platform)} · ${scopeLabel(entry.scope)}`).join('；')
        : '当前加载范围；其他项目引用未检查';
      const relationViewport = actionViewport(actions, policy.mode === 'compact', focus,
        scrollOffset, showTechnical ? responsiveBudget(3, 6) : responsiveBudget(7, 11));
      help = '↑↓ 选择 · → 展开 · ← 收起 · Enter 节点详情 · Esc 返回';
      content = <Box flexDirection="column">
        <StaticRow title={`当前检查范围 · ${scopeText}`} status="muted" compact />
        {projection.status.state === 'invalid'
          ? <Callout status="error" title="依赖关系无效" description={projection.status.message} /> : null}
        {unverifiedConsumerActions.length > 0
          ? <StaticRow title={`未验证声明者 · ${unverifiedConsumerActions.length} 个`} description="以下声明者不计入实际使用者" status="muted" compact />
          : null}
        <SemanticRows actions={actions} focus={focus} kind="action" compact
          offset={relationViewport.offset} limit={relationViewport.limit} />
        {showTechnical ? <TechnicalDetails>
          <StaticRow title={`${dependencyCount} 个依赖 · ${projection.scopeSummary.actualConsumerPluginIds.length} 个实际使用者`} meta={plugin.pluginId} compact />
          <StaticRow title={`未验证声明者 · ${projection.scopeSummary.unknownConsumerPluginIds.length} 个`} compact />
        </TechnicalDetails> : null}
      </Box>;
    }
  } else if (route.name === 'pluginDependencyNode' && plugin) {
    const node = props.controller.getPluginOverview(route.nodePluginId);
    const overview = dependencyOverview(plugin);
    const item = route.nodePluginId === plugin.pluginId ? undefined
      : route.direction === 'dependencies'
        ? overview?.dependencies.find((entry) => entry.pluginId === route.nodePluginId)
        : overview?.dependents.find((entry) => entry.pluginId === route.nodePluginId);
    const verifiedDependent = route.direction !== 'dependents'
      || (item?.placementReferences?.length ?? 0) > 0;
    const state = item ? dependencyStatus(item) : undefined;
    breadcrumb = `${plugin.displayName} / 依赖关系 / ${node?.displayName ?? route.nodePluginId}`;
    context = route.direction === 'dependencies' ? '它需要的' : '谁在使用它';
    title = node?.displayName ?? route.nodePluginId;
    description = route.nodePluginId === plugin.pluginId
      ? '这是当前关系图的根插件。'
      : route.direction === 'dependencies'
        ? `${item?.requiredBy.map((entry) => entry.displayName).join('、') || plugin.displayName} 需要这个插件。`
        : verifiedDependent
          ? `${node?.displayName ?? route.nodePluginId} 的已安装位置实际引用当前插件。`
          : `${item?.displayName ?? route.nodePluginId} 声明依赖当前插件，但当前没有实际引用证据。`;
    actions = [
      ...(route.nodePluginId !== plugin.pluginId ? [{
        label: '以此节点查看关系',
        description: '打开局部子树；面包屑保留来路',
        run: () => go({
          name: 'pluginDependencies',
          pluginId: route.nodePluginId,
          direction: route.direction,
        }),
      }] : []),
      { label: '返回关系图', run: back },
    ];
    content = <Box flexDirection="column">
      <SectionCard title="节点状态">
        <StaticRow title={node?.displayName ?? route.nodePluginId}
          meta={state?.value ?? (node ? statusText(node) : '未检查')} status={state?.status ?? 'muted'} compact />
        <StaticRow title={route.nodePluginId} description="canonical pluginId" status="muted" compact />
        {item?.placementReferences?.slice(0, responsiveBudget(1, 3)).map((reference) =>
          <StaticRow key={`${reference.consumer.pluginId}:${reference.consumer.platform}:${reference.consumer.scope}`}
            title={`${platformLabel(reference.consumer.platform)} · ${scopeLabel(reference.consumer.scope)}`}
            description={`${reference.consumer.pluginId} → ${reference.dependency.pluginId}`} compact />)}
      </SectionCard>
      <SemanticRows actions={actions} focus={focus} kind="action" compact={policy.mode === 'compact'} />
    </Box>;
  } else if (route.name === 'installPlacement' && plugin) {
    breadcrumb = `${plugin.displayName} / 添加`;
    context = '第 1 步，共 2 步';
    title = `你希望在哪里使用 ${plugin.displayName}？`;
    const hasDependencies = (plugin.dependencySummary?.totalCount ?? 0) > 0;
    description = hasDependencies
      ? '这里只选择根插件位置。依赖将采用 planner 推荐位置，并在 Review 中显示。'
      : '选择位置后，再选择一个或多个目标平台。';
    const availableScopes = (['user', 'project'] as const).filter((candidateScope) =>
      props.controller.listInstallTargets(plugin.pluginId, candidateScope)
        .some((entry) => entry.compatible));
    actions = [
      ...availableScopes.map((candidateScope) => ({
        label: scopeLabel(candidateScope),
        selected: candidateScope === scope,
        description: candidateScope === 'user'
          ? hasDependencies ? '根插件在任意项目中可用；依赖位置自动计算' : '在任意项目中可使用，适合个人常用能力'
          : hasDependencies ? '根插件只在当前项目使用；Review 会说明更宽的依赖位置' : '仅在当前项目中使用，适合团队共享',
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
      {hasDependencies ? <SectionCard title="依赖位置"><StaticRow title={`${plugin.dependencySummary?.totalCount ?? 0} 个依赖将采用推荐位置`} description="Review 中可查看或调整" status="info" /></SectionCard> : null}
    </Box>;
  } else if (route.name === 'installTargets' && plugin) {
    breadcrumb = `${plugin.displayName} / 添加 / 目标平台`;
    context = '第 2 步，共 2 步';
    title = '选择目标平台';
    const hasDependencies = (plugin.dependencySummary?.totalCount ?? 0) > 0;
    description = hasDependencies
      ? '根插件必须支持所选位置；确认后会自动规划依赖并进入 Review。'
      : '目标平台按所选位置验证；仅含平台共享内容的插件可同时启用两个位置。';
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
        description: draft?.canContinue ? '使用这些最终位置准备 Review' : undefined,
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
      ...(defaultCount > 0 ? [`默认 project ${defaultCount} 项`] : []),
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
              name: 'configLayer',
              pluginId: target.pluginId,
              ...(fieldKey ? { fieldKey } : {}),
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
            label: `更新并恢复 ${targetLabel}…`,
            description: '改用当前候选版本建立新任务；进入 Review 前仍会重新检查证据',
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
      if (missingTargetKeys.length > 0) {
        setActionError(`${missingTargetKeys.length} 个冻结位置已失效或无需处理。请返回调整后重新开始。`);
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
      ...(missingTargetKeys.length === 0 && !versionEvidenceChanged
        && blockedCandidates.length === 0 && executable.length > 0 ? [{
        label: `确认${taskLabel} ${executable.length} 个位置…`,
        description: '进入统一影响确认；执行前再次检查当前证据',
        status: 'success' as const,
        run: () => startTaskReview('all'),
      }] : []),
      ...(missingTargetKeys.length === 0 && !versionEvidenceChanged
        && blockedCandidates.length > 0 && executable.length > 0 ? [{
        label: `先处理可执行的 ${executable.length} 个位置…`,
        description: `${blockedCandidates.length} 个受阻位置保留，不会无声跳过`,
        status: 'warning' as const,
        run: () => startTaskReview('executableSubset'),
      }] : []),
      ...activationSources.map((sourceId) => ({
        label: `先更新来源目录 ${sourceId}…`,
        description: '先单独确认目录变更；启用完成后重新准备插件更新',
        status: 'warning' as const,
        run: () => beginReview({ kind: 'catalogGeneration', action: 'update', sourceId }),
      })),
      ...recoveryActions,
      ...(versionEvidenceChanged ? [{
        label: '使用当前版本重新准备…',
        description: '来源启用后的插件版本与先前候选不同；先明确采用当前版本',
        status: 'warning' as const,
        run: () => {
          props.controller.replace({ ...route, versionEvidence: currentVersionEvidence });
          setFocus(0);
          setScrollOffset(0);
        },
      }] : []),
      { label: '返回插件详情', run: back },
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
        title={`${missingTargetKeys.length} 个冻结位置已失效或无需处理`}
        description="不会把这些位置当作已完成，也不会自动缩小本次范围。请返回调整选择后重新开始。"
        compact={policy.mode === 'compact'} /> : null}
      {versionEvidenceChanged ? <Callout status="warning" title="插件目标版本已变化" description="不会沿用来源启用前的版本证据，也不会自动执行新版本。" compact={policy.mode === 'compact'} /> : null}
      <SemanticRows actions={actions} focus={focus} kind="action" compact offset={taskViewport.offset} limit={taskViewport.limit} />
    </Box>;
  } else if (route.name === 'pluginDetail' && plugin) {
    breadcrumb = `我的插件 / ${plugin.displayName}`;
    context = `${plugin.sourceLabel}${plugin.version ? ` · ${plugin.version}` : ''}`;
    title = plugin.displayName;
    description = plugin.description;
    const updateDescription = pluginUpdateDescription(plugin);
    const updateTaskCandidates: PluginWriteTaskCandidate[] = plugin.configOnly ? []
      : props.controller.listPluginWriteTaskCandidates('update')
        .filter((candidate) => candidate.target.pluginId === plugin.pluginId);
    const restoreTaskCandidates: PluginWriteTaskCandidate[] = plugin.configOnly ? []
      : props.controller.listPluginWriteTaskCandidates('restore')
        .filter((candidate) => candidate.target.pluginId === plugin.pluginId);
    const updateAction: ActionItem | undefined = updateTaskCandidates.length > 0 ? {
        label: updateTaskCandidates.length === 1 && updateTaskCandidates[0]?.target.expectedUpdate
          ? `更新到 ${updateTaskCandidates[0].target.expectedUpdate.activeVersion}…`
          : updateTaskCandidates.some((candidate) => candidate.target.expectedUpdate)
            ? `更新 ${plugin.displayName}…` : '准备插件更新…',
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
        label: '恢复正常…',
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
    const issueForPlugin = props.controller.listUserIssues().find((candidate) =>
      candidate.pluginId === plugin.pluginId || candidate.rootEntity?.pluginId === plugin.pluginId);
    const exceptionalAction: ActionItem | undefined = plugin.aggregateStatus === 'unavailable'
      ? plugin.capabilityUnsupported && !plugin.sourceUnavailable ? {
          label: '需要升级 AW CLI',
          description: '查看缺少的功能和安全恢复方向',
          status: 'warning',
          run: () => go({ name: 'pluginTechnical', pluginId: plugin.pluginId }),
        } : {
          label: '恢复插件来源…',
          description: '来源恢复后再重新检查插件状态',
          status: 'warning',
          run: () => go({ name: 'sourceDetail', sourceId: plugin.sourceId }),
        }
      : plugin.aggregateStatus === 'needsAttention' && !restoreAction ? {
          label: '查看处理建议',
          description: '当前问题需要先确认原因或处理方式',
          status: 'warning',
          run: () => issueForPlugin
            ? go({ name: 'issueDetail', issueId: issueForPlugin.issueId })
            : go({ name: 'pluginTechnical', pluginId: plugin.pluginId }),
        } : undefined;
    const primary = exceptionalAction ?? restoreAction ?? updateAction
      ?? settingsAction ?? {
        label: '使用说明',
        description: '查看用途、支持平台和来源',
        run: () => go({ name: 'pluginAbout', pluginId: plugin.pluginId }),
      };
    actions = [
      primary,
      ...(settingsAction && primary !== settingsAction ? [settingsAction] : [{
        label: '使用说明',
        description: '查看用途、支持平台和来源',
        run: () => go({ name: 'pluginAbout', pluginId: plugin.pluginId }),
      }]),
      {
        label: '更多操作…',
        description: '平台维护、依赖、通用 Skills、来源和诊断',
        run: () => go({ name: 'pluginMore', pluginId: plugin.pluginId }),
      },
    ];
    const dependencyOverviewForDetail = dependencyOverview(plugin);
    const dependencyIssue = dependencyOverviewForDetail?.dependencies.find((entry) =>
      entry.aggregateStatus !== 'ready');
    const dependencyDetailText = dependencyIssue
      ? `${dependencyIssue.aggregateStatus === 'notInstalled' ? '缺少' : '异常'} ${dependencyIssue.displayName}，${plugin.displayName} 暂时不可用。恢复会一并处理。`
      : dependencyOverviewForDetail && dependencyOverviewForDetail.summary.totalCount > 0
        ? `自动使用 ${dependencyOverviewForDetail.summary.totalCount} 个所需插件，全部就绪。查看关系…`
        : undefined;
    const detailViewport = actionViewport(actions, policy.mode === 'compact', focus, scrollOffset, pageActionBudget(4));
    content = <Box flexDirection="column">
      {updateDescription ? <Callout status="warning" title={statusText(plugin)} description={updateDescription} /> : null}
      {dependencyDetailText ? <StaticRow
        title={dependencyDetailText}
        status={dependencyIssue ? 'warning' : 'success'}
        compact
      /> : null}
      <SectionCard title="插件操作"><SemanticRows actions={actions} focus={focus} kind="action" compact={policy.mode === 'compact'} offset={detailViewport.offset} limit={detailViewport.limit} /></SectionCard>
    </Box>;
  } else if (route.name === 'pluginMore' && plugin) {
    breadcrumb = `我的插件 / ${plugin.displayName} / 更多操作`;
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
        label: '更新插件…',
        description: '使用精确版本和现有安装位置',
        status: 'warning' as const,
        run: () => go({
          name: 'pluginWriteTask', pluginId: plugin.pluginId, goal: 'update',
          targetKeys: updateTaskCandidates.map(pluginWriteTaskTargetKey),
          versionEvidence: pluginWriteTaskVersionEvidence(plugin, updateTaskCandidates),
        }),
      }] : []),
      ...(restoreTaskCandidates.length > 0 ? [{
        label: '恢复正常…',
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
            label: `处理 ${platformLabel(action.platform)} 位置冲突…`,
            description: action.description,
            status: 'error',
            run: () => beginScopeConflictRecovery(action),
          };
          if (action.id === 'dependencies') return {
            label: '依赖与被使用情况',
            description: dependencySummary?.issueCount ? `${dependencySummary.issueCount} 项需要处理` : '查看完整关系',
            meta: dependencySummary ? dependencySummaryText(dependencySummary) : undefined,
            run: () => go({ name: 'pluginDependencies', pluginId: plugin.pluginId }),
          };
          if (action.id === 'portableSkills') return {
            label: '在其他 Agent 使用',
            description: '通过 Skills CLI 选择和安装通用 Skills',
            run: () => beginPortable(plugin.pluginId),
          };
          if (action.id === 'settings') return {
            label: plugin.configOnly ? '查看已保存设置' : '插件设置',
            run: () => plugin.configOnly
              ? props.controller.beginSavedConfigRecovery(plugin.pluginId)
              : beginConfigFlow(plugin.pluginId),
          };
          if (action.id === 'sourceProblem') return {
            label: '恢复插件来源…', status: 'warning',
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
        label: '依赖与被使用情况',
        description: '查看必需依赖和已知使用者；当前没有声明的必需依赖',
        run: () => go({ name: 'pluginDependencies', pluginId: plugin.pluginId }),
      }] : []),
      { label: '使用说明', run: () => go({ name: 'pluginAbout', pluginId: plugin.pluginId }) },
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
        description: '增加这个使用位置；现有共享内容保持不变',
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
        label: `保留${scopeLabel(action.keepScope)}，移除${scopeLabel(action.scope)} root…`,
        description: action.description,
        status: 'error',
        run: () => beginScopeConflictRecovery(action),
      };
      if (action.id === 'refreshAndSync') return {
        label: `更新到 ${action.availableVersion}…`,
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
        label: `同步${scopeLabel(action.scope)}的使用位置…`,
        description: placement?.state === 'installed'
          ? (placement.scopedPlacements?.find((entry) => entry.scope === action.scope)?.recovery
            ?? placement.recovery)?.find((entry) => entry.command === 'sync')?.description
            ?? '进入现有 Review、进度和结果链修复 needsSync 或 drift'
          : undefined,
        run: () => placement?.state === 'installed'
          ? beginReview({ kind: 'pluginWrite', action: 'sync', pluginId: plugin.pluginId, platform: action.platform, scope: action.scope })
          : undefined,
      };
      if (action.id === 'reinstall') return { label: '重新安装…', description: '保留现有设置并重新生成受管内容', run: () => beginReview({ kind: 'pluginWrite', action: 'reinstall', pluginId: plugin.pluginId, platform: action.platform, scope: action.scope }) };
      if (action.id === 'remove') return { label: `从${scopeLabel(action.scope)}移除…`, description: '保留插件设置', status: 'error', run: () => beginPluginRemoval(plugin, action.platform, action.scope) };
      if (action.id === 'cleanup') return { label: `清理${scopeLabel(action.scope)}中的遗留内容…`, description: '先核验，再取消此位置的使用设置，并尽力清理可验证的 AW 内容', status: 'error', run: () => beginReview({ kind: 'pluginWrite', action: 'cleanup', pluginId: plugin.pluginId, platform: action.platform, scope: action.scope }) };
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
          label: `清理${scopeLabel(placement.scope)}中的遗留内容…`,
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
          label: '检查受限清理…',
          description: '只在当前单一目标有精确、专属的 AW 管理恢复证据时确认；先核验，再取消使用设置并尽力清理；共享和外来内容保留。',
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
      <StaticRow title="位置" meta={placement.desiredScopes?.map(scopeLabel).join('、') || scopeLabel(placement.scope)} compact />
      <StaticRow
        title="状态"
        meta={placement.actualState === 'ready' ? '可用'
          : placement.actualState === 'needsSync' ? '需要同步'
            : placement.actualState === 'blocked' ? '已阻断'
              : placement.health === 'incomplete' ? '需要处理' : '暂时不可用'}
        status={placement.actualState === 'ready' ? 'success' : placement.actualState === 'blocked' ? 'error' : 'warning'}
        compact
      />
      {placement.health !== 'ready'
        ? <StaticRow title="原因" meta={placement.blockingReason === 'artifactCollision' ? '输出位置存在冲突内容' : '当前安装与已保存设置不一致'} status="warning" compact />
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
    title = selectedField ? `修改“${selectedField.title}”`
      : selectedPreset ? `应用“${selectedPreset.title}”` : `修改 ${plugin.displayName} 设置`;
    description = selectedField
      ? `当前：${effectiveFieldDisplay(selectedField)} · ${selectedField.effectiveSourceLabel}。选择保存位置后直接编辑。`
      : selectedPreset ? '选择保存位置后，方案会应用到该位置的草稿。' : '选择修改保存到哪里。';
    help = '↑↓ 移动 · Enter 打开 · Esc 返回';
    const canUseLayer = (scope: Scope): boolean => {
      const page = configLayerPages[scope];
      if (!page) {
        if (scope === 'user') return true;
        if (selectedField) return !selectedField.sensitive && !selectedField.sharedNativeRender;
        if (selectedPreset && configLayerDefinitionPage) {
          const effectiveFields = configLayerDefinitionPage.groups.flatMap((group) => group.fields);
          return Object.keys(selectedPreset.values).some((key) => {
            const field = effectiveFields.find((candidate) => candidate.key === key);
            return Boolean(field && !field.sensitive && !field.sharedNativeRender);
          });
        }
        return true;
      }
      const fields = page.groups.flatMap((group) => group.fields);
      if (route.fieldKey) {
        const field = fields.find((candidate) => candidate.key === route.fieldKey);
        return Boolean(field && (configFieldCanSet(field) || configFieldCanUnset(field)));
      }
      if (selectedPreset) {
        return Object.keys(selectedPreset.values).some((key) => {
          const field = fields.find((candidate) => candidate.key === key);
          return Boolean(field && configFieldCanSet(field));
        });
      }
      return fields.some((field) => configFieldCanSet(field) || configFieldCanUnset(field));
    };
    actions = [
      ...(canUseLayer('user') ? [{
        label: '个人默认',
        description: '影响个人的所有项目；项目设置仍可覆盖',
        meta: configLayerCounts.user === undefined ? undefined : `${configLayerCounts.user} 个值`,
        run: () => openConfigLayerTarget({ scope: 'user' }),
      }] : []),
      ...(canUseLayer('project') ? [{
        label: '当前项目',
        description: '修改仅对当前项目生效；适合随仓库共享的约定',
        meta: configLayerCounts.project === undefined ? undefined : `${configLayerCounts.project} 个值`,
        run: () => openConfigLayerTarget({ scope: 'project' }),
      }] : []),
    ];
    content = actions.length > 0
      ? <SemanticRows actions={actions} focus={focus} kind="section" compact={policy.mode === 'compact'} />
      : <StatusCard status="info" title="正在检查可用保存位置" />;
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
      content = <StatusCard status="info" title="正在读取可信设置定义"><ProgressRow title="读取插件设置字段" state="active" /></StatusCard>;
    } else {
      visibleConfigTabs = configTabs(currentConfigPage);
      const requestedTab = snapshot.router.current.context.configGroupId;
      const activeTab = visibleConfigTabs.find((tab) => tab.id === requestedTab) ?? visibleConfigTabs[0];
      activeConfigTabId = activeTab?.id;
      const activeGroup = activeTab?.kind === 'group'
        ? currentConfigPage.groups.find((group) => group.id === activeTab.id)
        : undefined;
      const projectSharedNativeFields = route.layer.scope === 'project'
        ? (activeGroup?.fields ?? []).filter((field) => field.sharedNativeRender && !field.writable)
        : [];
      if (projectSharedNativeFields.length > 0) {
        description += ' 此设置由个人默认控制平台共享内容；当前项目不可改。更改影响所有项目。';
      }
      if (projectSharedNativeFields.some(configFieldCanUnset)) {
        description += ' 发现不再支持的 project override；实际使用 user/default；请删除旧值。';
      }
      if (!readonly && configDraftIssues.length > 0) {
        description += ' 字段已变化；失效草稿不会保存。';
      }
      const mutableLayer = {
        scope: route.layer.scope as Scope,
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
        : (activeGroup?.fields ?? []).filter((field) => readonly || configFieldCanSet(field) || configFieldCanUnset(field)).map((field) => ({
            label: field.title,
            description: field.invalidOverrideIssue
              ? field.invalidOverrideOwnedByLayer
                ? `${field.invalidOverrideIssue} 删除后恢复：${field.fallbackDisplayValue ?? '未设置'} · ${field.fallbackSourceLabel ?? '未设置'}`
                : field.invalidOverrideIssue
              : readonly
              ? field.sourceLabel === '未设置' ? '没有任何位置提供值' : `来自${field.sourceLabel}`
              : !configFieldCanSet(field) && configFieldCanUnset(field)
                ? '不再支持的 project override · 实际使用 user/default · 可删除旧值'
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
              : () => go(field.configured || !configFieldCanSet(field) ? {
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
      const operationActions: ActionItem[] = readonly ? [] : [
        ...(configDraftIssues.length > 0 ? [{
          label: '放弃已变化字段的草稿',
          description: `${configDraftIssues.length} 项草稿的字段不存在、不可编辑或不再可删除；不会修改已保存设置。`,
          status: 'warning' as const,
          run: discardInvalidConfigDraftChanges,
        }] : []),
        ...(dirty && configDraftIssues.length === 0 ? [{
          label: '查看保存汇总',
          description: '确认变化，再选择只保存或保存并应用',
          status: 'success' as const,
          run: () => {
            setFocus(0);
            go({ name: 'configSave', pluginId: route.pluginId, layer: route.layer as { scope: Scope } });
          },
        }] : []),
        ...(currentConfigPage.storedCount > 0 ? [{
          label: route.layer.scope === 'user'
            ? '清空个人默认…'
            : '清空当前项目设置…',
          description: `删除${configLayerLabel(route.layer)}中的全部值并恢复继承；其他设置层保持不变`,
          status: 'error' as const,
          run: () => beginReview({
            kind: 'configReset',
            pluginId: plugin.pluginId,
            scope: route.layer.scope as Scope,
            changes: currentConfigPage.groups.flatMap((group) => group.fields)
              .filter((field) => field.configured)
              .map((field) => ({
                key: field.key,
                title: field.title,
                before: field.displayValue,
                after: `恢复继承（${field.fallbackDisplayValue ?? '未设置'} · ${field.fallbackSourceLabel ?? '未设置'}）`,
                ...(field.fallbackObjectChanges?.length
                  ? { children: field.fallbackObjectChanges }
                  : {}),
              })),
          }),
        }] : []),
      ];
      actions = [...tabActions, ...operationActions];
      const effectiveConfigFocus = Math.min(focus, Math.max(0, actions.length - 1));
      const focusedConfigField = effectiveConfigFocus < (activeGroup?.fields.length ?? 0)
        ? activeGroup?.fields[effectiveConfigFocus]
        : undefined;
      if (!readonly) {
        const canUnsetFocused = focusedConfigField
          ? configFieldCanUnset(focusedConfigField)
            && (!focusedConfigField.invalidOverrideIssue
              || focusedConfigField.invalidOverrideOwnedByLayer === true)
          : false;
        help = canUnsetFocused
          ? '↑↓ 移动 · Enter 修改 · ←→ 分组 · s 查看汇总 · u 恢复继承 · Esc 返回'
          : '↑↓ 移动 · Enter 修改 · ←→ 分组 · s 查看汇总 · Esc 返回';
      }
      const fieldFocus = tabActions.length > 0
        ? effectiveConfigFocus < tabActions.length ? effectiveConfigFocus : Math.min(scrollOffset, tabActions.length - 1)
        : 0;
      const operationRows = operationActions.reduce((rows, action) =>
        rows + (policy.mode === 'compact' || !action.description ? 1 : 2), 0);
      const viewport = actionViewport(tabActions, policy.mode === 'compact', fieldFocus, scrollOffset,
        pageActionBudget(1 + operationRows + 3 + (configDraftIssues.length > 0 ? 3 : 0)));
      const totalFields = currentConfigPage.groups.reduce((count, group) => count + group.fields.length, 0);
      const countLabel = `${totalFields} 项${currentConfigPage.presets.length > 0 ? ` · ${currentConfigPage.presets.length} 个方案` : ''}`;
      context = readonly ? countLabel
        : dirty ? `${Object.keys(draftUpdates).length + draftRemoves.length} 项未保存` : countLabel;
      content = <Box flexDirection="column">
        {!readonly && configDraftIssues.length > 0 ? <Callout
          status="warning"
          title="字段已变化"
          description="来源恢复后字段定义已更新；字段可能不存在、不可编辑或不再可删除。请显式放弃失效草稿，或返回继续检查来源；不会自动保存或复用旧确认。"
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
  } else if (route.name === 'configSave' && plugin && currentConfigPage) {
    const changes = configChanges();
    const affectedTargets = configSaveImpact?.affectedTargets ?? [];
    const hasConsumers = configSaveImpact?.impactState === 'known' && affectedTargets.length > 0;
    const targetSummary = affectedTargets
      .map((target) => `${platformLabel(target.platform)} · ${scopeLabel(target.scope)}`)
      .join('、');
    breadcrumb = `${plugin.displayName} / 设置 / 保存汇总`;
    context = `${changes.length} 项未保存`;
    title = `保存 ${changes.length} 项设置修改？`;
    description = route.layer.scope === 'project'
      ? '修改将保存到当前项目。'
      : '修改将保存为个人默认，并影响个人的所有项目；项目设置仍可覆盖。';
    actions = configSaveImpact ? [
      hasConsumers ? {
        label: '保存并生效',
        description: `保存设置，并重新应用：${targetSummary}`,
        status: 'success',
        run: () => beginConfigSave(true),
      } : {
        label: '保存设置',
        description: '当前修改没有需要重新应用的已安装目标',
        status: 'success',
        run: () => beginConfigSave(false),
      },
      ...(hasConsumers ? [{
        label: '只保存，稍后应用',
        description: '保存所选设置层，不重新应用当前目标',
        run: () => beginConfigSave(false),
      }] : []),
      { label: '返回修改', run: back },
    ] : [{ label: '返回修改', run: back }];
    content = <Box flexDirection="column"><SectionCard title="设置变更" compact={policy.mode === 'compact'}>
      {changes.map((change) => <ReviewChangeRow
        key={change.key}
        title={`~ ${draftRemoves.includes(change.key) ? `删除 ${change.title} 中的值` : change.title}`}
        description={`${change.before} → ${change.after}`}
        compact={policy.mode === 'compact'}
      />)}
    </SectionCard><SectionCard title="应用影响" compact={policy.mode === 'compact'}>
      {!configSaveImpact && !configSaveImpactError
        ? <ProgressRow title="分析实际配置消费者" state="active" />
        : hasConsumers
          ? affectedTargets.map((target) => <StaticRow
              key={`${target.platform}:${target.scope}`}
              title={`${platformLabel(target.platform)} · ${scopeLabel(target.scope)}`}
              meta="需要重新应用"
              status="warning"
              compact
            />)
          : <StaticRow
              title={configSaveImpactError || configSaveImpact?.impactState === 'unknown'
                ? '无法确认需要重新应用的目标；本次仅保存设置'
                : '没有需要重新应用的已安装目标'}
              status={configSaveImpactError || configSaveImpact?.impactState === 'unknown' ? 'warning' : 'success'}
              compact
            />}
      <StaticRow title="其他设置层保持不变" status="success" compact />
    </SectionCard><SemanticRows actions={actions} focus={focus} kind="action" compact={policy.mode === 'compact'} /></Box>;
  } else if (route.name === 'configFieldAction' && plugin && activeField) {
    const layer = configLayerLabel(route.layer);
    breadcrumb = `${plugin.displayName} / 设置 / ${layer} / ${activeField.title}`;
    title = activeField.title;
    description = `这个字段在${layer}中已经有值。`;
    help = '↑↓ 移动 · Enter 选择 · Esc 返回';
    const deleteLabel = route.layer.scope === 'user'
      ? '删除个人默认中的值'
      : '删除当前项目中的值';
    actions = [
      ...(configFieldCanSet(activeField) ? [{
        label: '修改值…',
        run: () => go({
          name: 'configFieldEditor',
          pluginId: plugin.pluginId,
          layer: route.layer,
          fieldKey: activeField.key,
          editor: fieldEditor(activeField),
          ...fieldEditorMode(activeField),
        }),
      }] : []),
      ...(configFieldCanUnset(activeField) && (!activeField.invalidOverrideIssue || activeField.invalidOverrideOwnedByLayer) ? [draftRemoves.includes(activeField.key)
        ? { label: '撤销删除', run: () => { cancelDraftRemoval(activeField.key); back(); } }
        : { label: deleteLabel, status: 'error' as const, run: () => { removeDraft(activeField.key); back(); } }] : []),
    ];
    content = <Box flexDirection="column"><SectionCard>
      {activeField.invalidOverrideIssue
        ? <StaticRow title="当前覆盖无效" meta={activeField.invalidOverrideIssue} status="warning" />
        : null}
      {!configFieldCanSet(activeField) && configFieldCanUnset(activeField)
        ? <StaticRow title="不再支持的 project override" meta="实际使用 user/default；删除旧值后保持继承" status="warning" />
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
      description = activeField.allowCustom
        ? '先选择插件提供的方案，也可以继续自定义。'
        : '此字段只允许使用插件提供的方案。';
      help = '↑↓ 移动 · Enter 使用 · Esc 取消';
      const current = draftUpdates[activeField.key] ?? activeField.draftValue ?? activeField.value;
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
          run: () => { updateDraft(activeField.key, preset.value); back(); },
        })),
        ...booleanCustomValues.map((value) => ({
          label: value ? '开启' : '关闭',
          selected: !activeField.sensitive && current === value,
          run: () => { updateDraft(activeField.key, value); back(); },
        })),
        ...(activeField.allowCustom && activeField.type !== 'boolean' ? [{
          label: '自定义…',
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
      actions = [{ label: '开启', selected: !activeField.sensitive && (draftUpdates[activeField.key] === true || (!Object.hasOwn(draftUpdates, activeField.key) && activeField.value === true)), run: () => { updateDraft(activeField.key, true); back(); } }, { label: '关闭', selected: !activeField.sensitive && (draftUpdates[activeField.key] === false || (!Object.hasOwn(draftUpdates, activeField.key) && activeField.value === false)), run: () => { updateDraft(activeField.key, false); back(); } }];
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
          label: '修改值…',
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
              label: '自定义…',
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
              label: `重置${scope === 'user' ? '个人默认' : '当前项目'}设置层…`,
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
  } else if (route.name === 'catalogManagement') {
    breadcrumb = '插件来源 / 目录管理';
    title = '目录管理';
    description = '选择任务后才读取对应的本地状态。';
    actions = [
      { label: 'Catalog 工作区', description: '选择、创建、查看状态、修改版本、构建和验证', run: () => go({ name: 'catalogWorkspace', view: 'overview' }) },
      { label: '开发来源', description: '查看、启用或停用当前 Workspace 的开发来源', run: () => go({ name: 'catalogDev' }) },
      { label: '本地存储', description: '查看保留项并预览可安全清理的空间', run: () => go({ name: 'catalogStore' }) },
      { label: 'Catalog 发布', description: '准备计划、独立应用和恢复可信 pending 计划', run: () => go({ name: 'catalogPublish', step: 'overview' }) },
    ];
    content = <Box flexDirection="column"><CatalogManagementIntro /><SemanticRows actions={actions} focus={focus} kind="task" compact={policy.mode === 'compact'} /></Box>;
  } else if (route.name === 'catalogWorkspace' && route.view === 'overview') {
    const model = catalogWorkspace ? {
      label: catalogWorkspace.label,
      state: catalogWorkspace.state,
      workspaceIdentity: catalogWorkspace.identity ?? undefined,
      catalogVersion: catalogWorkspace.catalog.version ?? undefined,
      channel: catalogWorkspace.catalog.channel ?? undefined,
      pluginCount: catalogWorkspace.plugins.length,
      snapshotState: catalogWorkspace.snapshot.state,
      gitState: !catalogWorkspace.git.checked ? '未检查'
        : !catalogWorkspace.git.hasHead ? '没有 HEAD'
          : catalogWorkspace.git.clean ? 'clean' : '有未提交变化',
      issues: catalogWorkspace.issues.map((issue) => issue.message),
    } : undefined;
    breadcrumb = '目录管理 / Catalog 工作区';
    title = 'Catalog 工作区';
    description = '状态读取不会 build、fetch、创建生成目录或运行插件代码。';
    actions = [
      { label: '选择其他工作区…', description: '输入路径；界面只显示目录名', run: () => { setCatalogInput(''); go({ name: 'catalogWorkspace', view: 'select' }); } },
      ...(catalogWorkspace?.state !== 'ready' ? [{
        label: '在所选目录创建工作区…', description: '输入 owner、显示名称和初始 Catalog 版本',
        run: () => { setCatalogInput(catalogWorkspaceDraft.ownerName); go({ name: 'catalogWorkspace', view: 'create', step: 'ownerName' }); },
      }] : []),
      ...(catalogWorkspace?.state === 'ready' ? [
        { label: '修改 Catalog 版本…', description: '选择 bump，或输入稳定版和精确 beta 版本', run: () => go({ name: 'catalogWorkspace', view: 'version' }) },
        ...(catalogWorkspace.snapshot.state === 'absent' ? [{
          label: '构建 Catalog…', description: `bundle 并验证 ${catalogWorkspace.plugins.length} 个 canonical plugins；写入 .aw/catalog`,
          run: () => beginReview({ kind: 'catalogManagement', action: 'workspaceBuild' }),
        }] : catalogWorkspace.snapshot.valid ? [{
          label: '重新构建 Catalog…', description: '替换已证明为生成物的 .aw/catalog；不删除其他内容',
          status: 'warning' as const,
          run: () => beginReview({ kind: 'catalogManagement', action: 'workspaceBuild', force: true }),
        }] : [{
          label: '生成目录无效，不能自动替换', description: '请检查问题并移开无法证明为生成物的目录后再构建',
          status: 'error' as const, disabled: '现有生成目录未通过安全验证',
        }]),
        { label: '完整验证生成目录', description: '只读验证现有 .aw/catalog，不重新构建', run: async () => {
          setCatalogLoading(true); setCatalogValidation(undefined); setCatalogInputError(undefined);
          try { setCatalogValidation(await props.controller.validateCatalogWorkspace()); }
          catch (error) { setCatalogInputError(sanitizeDiagnosticText(error instanceof Error ? error.message : String(error), [], [])); }
          finally { setCatalogLoading(false); }
        } },
      ] : []),
    ];
    const viewport = actionViewport(actions, policy.mode === 'compact', focus, scrollOffset, pageActionBudget(6));
    content = <Box flexDirection="column"><CatalogWorkspaceSummary model={model} loading={catalogLoading} />
      {catalogValidation ? <SectionCard title="完整验证结果"><StaticRow title={catalogValidation.state === 'valid' ? '生成目录有效' : catalogValidation.state === 'absent' ? '生成目录不存在' : '生成目录无效'} meta={catalogValidation.catalogVersion ?? undefined} status={catalogValidation.state === 'valid' ? 'success' : 'warning'} compact />{catalogValidation.issues.map((issue) => <StaticRow key={issue.code} title={issue.message} meta={issue.code} status="warning" compact />)}</SectionCard> : null}
      {catalogInputError ? <Callout status="error" title="无法读取工作区" description={catalogInputError} /> : null}
      <SemanticRows actions={actions} focus={focus} kind="action" compact={policy.mode === 'compact'} offset={viewport.offset} limit={viewport.limit} /></Box>;
  } else if (route.name === 'catalogWorkspace' && route.view === 'select') {
    breadcrumb = '目录管理 / Catalog 工作区 / 选择';
    title = '输入 Workspace 路径';
    description = '相对路径从当前目录解析；输入保持在本地，不写入配置。';
    help = '输入 · Enter 选择 · Ctrl-U 清空 · Esc 取消';
    content = <InputCard focused title={<InputDisplay value={privatePathInput(catalogInput)} columns={Math.max(8, size.columns - 8)} />} description={catalogInputError ?? '留空可恢复从当前目录自动发现。'} status={catalogInputError ? 'error' : undefined} />;
  } else if (route.name === 'catalogWorkspace' && route.view === 'create') {
    const step = route.step ?? 'ownerName';
    breadcrumb = '目录管理 / Catalog 工作区 / 创建';
    context = ({ ownerName: '第 1 步，共 4 步', ownerUrl: '第 2 步，共 4 步', displayName: '第 3 步，共 4 步', catalogVersion: '第 4 步，共 4 步' } as const)[step];
    title = ({ ownerName: '输入 owner 名称', ownerUrl: '输入 owner URL', displayName: '输入 Catalog 显示名称', catalogVersion: '输入初始 Catalog 版本' } as const)[step];
    description = step === 'catalogVersion' ? '允许稳定 x.y.z 或精确 x.y.z-beta.N。' : '所有字段会在创建确认中再次显示。';
    help = '输入 · Enter 继续 · Ctrl-U 清空 · Esc 取消';
    const displayValue = step === 'ownerUrl'
      ? catalogInput ? `已输入 owner URL（${Array.from(catalogInput).length} 字符）` : ''
      : catalogInput;
    content = <InputCard focused title={<InputDisplay value={displayValue} columns={Math.max(8, size.columns - 8)} />} description={catalogInputError ?? '按 Enter 继续。'} status={catalogInputError ? 'error' : undefined} />;
  } else if (route.name === 'catalogWorkspace' && route.view === 'version') {
    breadcrumb = '目录管理 / Catalog 工作区 / 版本';
    title = route.step === 'catalogVersion' ? '输入精确 Catalog 版本' : '修改 Catalog 版本';
    description = route.step === 'catalogVersion' ? '允许稳定 x.y.z 或精确 x.y.z-beta.N。' : `当前版本：${catalogWorkspace?.catalog.version ?? '未知'}`;
    if (route.step === 'catalogVersion') {
      help = '输入 · Enter 确认 · Ctrl-U 清空 · Esc 取消';
      content = <InputCard focused title={<InputDisplay value={catalogInput} columns={Math.max(8, size.columns - 8)} />} description={catalogInputError ?? '此动作会进入独立确认。'} status={catalogInputError ? 'error' : undefined} />;
    } else {
      actions = [
        { label: '提高 patch 版本', run: () => beginReview({ kind: 'catalogManagement', action: 'workspaceVersion', bump: 'patch' }, { name: 'catalogWorkspace', view: 'overview' }) },
        { label: '提高 minor 版本', run: () => beginReview({ kind: 'catalogManagement', action: 'workspaceVersion', bump: 'minor' }, { name: 'catalogWorkspace', view: 'overview' }) },
        { label: '提高 major 版本', run: () => beginReview({ kind: 'catalogManagement', action: 'workspaceVersion', bump: 'major' }, { name: 'catalogWorkspace', view: 'overview' }) },
        { label: '输入精确版本…', description: '用于指定稳定版或精确 beta.N', run: () => { setCatalogInput(''); go({ name: 'catalogWorkspace', view: 'version', step: 'catalogVersion' }); } },
      ];
      content = <SemanticRows actions={actions} focus={focus} kind="choice" compact={policy.mode === 'compact'} />;
    }
  } else if (route.name === 'catalogDev' && (!route.step || route.step === 'overview')) {
    const snapshotReady = catalogDev?.snapshot.state === 'current' && catalogDev.snapshot.valid;
    breadcrumb = '目录管理 / 开发来源';
    title = '开发来源';
    description = '状态只读取所选 Workspace、managed Path source 和 Active digest。';
    actions = [
      { label: '设置开发来源 ID…', description: catalogDevSourceId || '使用安全默认值', run: () => { setCatalogInput(catalogDevSourceId); go({ name: 'catalogDev', step: 'sourceId' }); } },
      ...!snapshotReady ? catalogDev?.snapshot.state === 'absent' ? [
        { label: '先构建 Catalog…', description: '先完成独立构建确认；构建成功后返回此页再确认启用',
          run: () => beginReview({ kind: 'catalogManagement', action: 'workspaceBuild' }, { name: 'catalogDev' }) },
      ] : catalogDev?.snapshot.state === 'stale' && catalogDev.snapshot.valid ? [
        { label: '先重新构建 Catalog…', description: '独立确认替换受管的旧 .aw/catalog；成功后返回此页再确认启用',
          status: 'warning' as const,
          run: () => beginReview({ kind: 'catalogManagement', action: 'workspaceBuild', force: true }, { name: 'catalogDev' }) },
      ] : [
        { label: '生成目录无效，不能自动替换', description: '请先在 Workspace 管理页检查问题；移开无法证明为生成物的目录后再构建',
          status: 'error' as const, disabled: '现有生成目录未通过安全验证' },
      ] : catalogDev?.source.exists ? [
        ...!catalogDev.ready && snapshotReady ? [{
          label: '重新启用并同步开发来源…', description: '来源配置已存在；重新使用当前有效 snapshot 完成 sync 和 Active 切换',
          status: 'warning' as const,
          run: () => beginReview({ kind: 'catalogManagement', action: 'devActivate',
            ...(catalogDevSourceId ? { sourceId: catalogDevSourceId } : {}) }, { name: 'catalogDev' }),
        }] : [],
        { label: '停用开发来源…', description: '保留 .aw/catalog；检查安装、设置和 Marketplace 引用', run: () => beginReview({ kind: 'catalogManagement', action: 'devDeactivate' }) },
        { label: '停用并选择替代主来源…', description: '开发来源为主来源时使用', run: () => { setCatalogInput(''); go({ name: 'catalogDev', step: 'replacementPrimary' }); } },
      ] : [
        { label: '启用开发来源…', description: '使用当前有效 snapshot 注册 managed Path source 并 sync', run: () => beginReview({ kind: 'catalogManagement', action: 'devActivate', ...(catalogDevSourceId ? { sourceId: catalogDevSourceId } : {}) }) },
        { label: '启用并设为主来源…', description: '将来源启用和主来源变化放在同一影响确认中', run: () => beginReview({ kind: 'catalogManagement', action: 'devActivate', primary: true, ...(catalogDevSourceId ? { sourceId: catalogDevSourceId } : {}) }) },
      ],
    ];
    content = <Box flexDirection="column"><StatusCard status={catalogDev?.ready ? 'success' : catalogDev?.state === 'needsAttention' ? 'warning' : 'info'} title={catalogLoading ? '正在读取开发来源' : catalogDev?.ready ? '开发来源可用' : catalogDev?.state === 'inactive' ? '开发来源未启用' : '开发来源需要处理'}>
      {catalogDev ? <><StaticRow title="生成目录" meta={catalogDev.snapshot.state} compact /><StaticRow title="来源" meta={catalogDev.source.id ?? '未注册'} compact /><StaticRow title="Active" meta={catalogDev.active.ready ? '可用' : catalogDev.active.exists ? '需要处理' : '不存在'} compact /></> : null}
    </StatusCard>{catalogInputError ? <Callout status="error" title="无法读取开发来源" description={catalogInputError} /> : null}<SemanticRows actions={actions} focus={focus} kind="action" compact={policy.mode === 'compact'} /></Box>;
  } else if (route.name === 'catalogDev') {
    const replacement = route.step === 'replacementPrimary';
    breadcrumb = '目录管理 / 开发来源 / 输入';
    title = replacement ? '输入替代主来源 ID' : '输入开发来源 ID';
    description = replacement ? '停用和主来源变化会进入同一次影响确认。' : '留空可使用安全默认 ID。';
    help = '输入 · Enter 继续 · Ctrl-U 清空 · Esc 取消';
    content = <InputCard focused title={<InputDisplay value={catalogInput} columns={Math.max(8, size.columns - 8)} />} description={catalogInputError ?? '按 Enter 继续。'} status={catalogInputError ? 'error' : undefined} />;
  } else if (route.name === 'catalogStore') {
    const entries = catalogStore?.entries ?? [];
    const pageRows = responsiveBudget(3, 7);
    const entryOffset = Math.min(batchTargetOffset, Math.max(0, entries.length - 1));
    const entryEnd = Math.min(entries.length, entryOffset + pageRows);
    const reclaimable = entries.filter((entry) => entry.status === 'reclaimable');
    breadcrumb = '目录管理 / 本地存储';
    title = '本地 Catalog Store';
    description = '只清理已确认且执行时仍安全的弱状态；未知、foreign 和 Active 内容始终保留。';
    if (entries.length > pageRows) help = 'PgUp/PgDn 查看全部条目 · ↑↓ 移动 · Enter 选择 · Esc 返回';
    actions = [{
      label: '预览并清理可安全释放的空间…',
      description: `${reclaimable.length} 项；确认后新增候选不进入本次删除集合`,
      disabled: reclaimable.length ? undefined : '当前没有可安全清理的条目',
      run: () => beginReview({ kind: 'catalogManagement', action: 'storePrune', items: reclaimable.map((entry) => entry.item) }),
    }];
    content = <Box flexDirection="column">{catalogStore ? <CatalogStoreSummary
      reclaimableCount={catalogStore.totals.reclaimableEntries}
      reclaimableBytes={catalogStore.totals.reclaimableBytes ?? 0}
      retainedCount={catalogStore.totals.retainedEntries}
      entries={entries.map((entry) => ({ key: entry.itemKey, title: `${entry.category} · ${entry.itemKey}`, meta: `${entry.reason}${entry.reclaimableBytes === null ? '' : ` · ${entry.reclaimableBytes} bytes`}`, status: entry.status === 'error' ? 'unsafe' : entry.status === 'active' ? 'retained' : entry.status }))}
      before={entryOffset} after={entryEnd}
    /> : <StatusCard status="info" title="正在读取本地 Catalog Store" />}
      {catalogInputError ? <Callout status="error" title="无法读取 Store" description={catalogInputError} /> : null}
      <SemanticRows actions={actions} focus={focus} kind="action" compact={policy.mode === 'compact'} /></Box>;
  } else if (route.name === 'catalogPublish' && route.step === 'overview') {
    const records = catalogPublication?.records ?? [];
    const pageRows = responsiveBudget(3, 7);
    const recordOffset = Math.min(batchTargetOffset, Math.max(0, records.length - 1));
    const recordEnd = Math.min(records.length, recordOffset + pageRows);
    breadcrumb = '目录管理 / Catalog 发布';
    title = 'Catalog 发布';
    description = '准备计划与应用计划是两个独立写入动作。';
    if (records.length > pageRows) help = 'PgUp/PgDn 查看全部记录 · ↑↓ 移动 · Enter 选择 · Esc 返回';
    actions = [
      { label: '准备新发布计划…', description: '下一步输入 remote 或 URL 与 branch；执行 plan 会写 version-scoped journal 和隔离仓库', run: () => { setCatalogInput(catalogPublishDraft.expectedPlanDigest ? '' : catalogPublishDraft.target); setCatalogPublishDraft((draft) => draft.expectedPlanDigest ? { targetKind: 'remote', target: '', branch: 'catalog' } : draft); go({ name: 'catalogPublish', step: 'target' }); } },
      ...records.filter((record) => record.canApply && record.planDigest).map((record) => ({
        label: `${record.state === 'uncertain' ? '对账或继续' : '应用'} ${record.catalogVersion}…`,
        description: record.requiresRemoteInput
          ? '重新输入原 remote 名称或 URL；只恢复现有可信 plan digest'
          : '只使用现有可信 plan digest；不会从当前源码重建计划',
        status: record.state === 'uncertain' ? 'warning' as const : undefined,
        run: () => record.requiresRemoteInput
          ? (() => {
              setCatalogPublishDraft({ targetKind: 'remote', target: '', branch: record.branch ?? 'catalog', expectedPlanDigest: record.planDigest! });
              setCatalogInput('');
              go({ name: 'catalogPublish', step: 'target' });
            })()
          : beginReview({ kind: 'catalogManagement', action: 'publishApply', expectedPlanDigest: record.planDigest!, ...(record.remote ? { remote: record.remote } : {}), ...(record.branch ? { branch: record.branch } : {}) }, { name: 'catalogPublish', step: 'overview' }),
      })),
      ...records.filter((record) => record.mustIncreaseVersion).map((record) => ({
        label: `${record.catalogVersion} 无法恢复`, description: 'journal 或 pending repository 缺失或损坏；请提高 Catalog 版本后创建新计划', status: 'error' as const, disabled: '不能重建或复用此版本',
      })),
    ];
    const viewport = actionViewport(actions, policy.mode === 'compact', focus, scrollOffset, pageActionBudget(5));
    content = <Box flexDirection="column">{catalogPublication ? <CatalogPublicationSummary records={records.map((record) => ({ key: `${record.catalogVersion}:${record.state}`, catalogVersion: record.catalogVersion, state: record.state, branch: record.branch ?? undefined, message: record.issue?.message }))} before={recordOffset} after={recordEnd} /> : <StatusCard status="info" title="正在读取本地发布记录" />}
      {catalogInputError ? <Callout status="error" title="无法读取发布记录" description={catalogInputError} /> : null}
      <SemanticRows actions={actions} focus={focus} kind="action" compact={policy.mode === 'compact'} offset={viewport.offset} limit={viewport.limit} /></Box>;
  } else if (route.name === 'catalogPublish') {
    breadcrumb = '目录管理 / Catalog 发布 / 准备计划';
    title = route.step === 'target' ? '输入 remote 名称或 remote URL' : '输入发布 branch';
    description = route.step === 'target'
      ? catalogPublishDraft.expectedPlanDigest
        ? '重新输入原目标。后端会与现有 plan digest 中的目标身份核对。'
        : 'URL 只显示脱敏摘要；remote 名称按原样使用。'
      : '留空使用固定默认 branch：catalog。';
    help = '输入 · Enter 继续 · Ctrl-U 清空 · Esc 取消';
    const displayValue = route.step === 'target'
      ? catalogInput ? `已输入远程目标（${Array.from(catalogInput).length} 字符）` : ''
      : catalogInput;
    content = <InputCard focused title={<InputDisplay value={displayValue} columns={Math.max(8, size.columns - 8)} />} description={catalogInputError ?? (route.step === 'branch' ? '执行 plan 会写 publication journal 和隔离仓库；取消 Review 不写入。' : '按 Enter 继续。')} status={catalogInputError ? 'error' : undefined} />;
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
        const freshness = props.controller.getCatalogFreshness(source.id);
        const health = overview.health?.state ?? source.state;
        const presentation = catalogSourceListPresentation({
          freshness,
          activeVersion: generation?.active?.catalogVersion,
          health,
          primary: source.primary,
        });
        return {
          label: `${source.id}${source.primary ? '  主来源' : ''}`,
          description: `${overview.detail?.type === 'path' ? '本地目录' : 'Git 仓库'} · ${source.count ?? 0} 个插件`,
          meta: presentation.label,
          status: presentation.status,
          run: () => go({ name: 'sourceDetail', sourceId: source.id }),
        };
      }),
      { label: '＋ 添加来源', description: 'Git 仓库或本地目录', run: beginAddSource },
      {
        label: '检查全部来源',
        description: '并行检查各来源；结果不会自动启用待检查版本',
        run: () => props.controller.recheckAllCatalogSources(),
      },
      {
        label: '目录管理…',
        description: 'Catalog 工作区、开发来源、本地存储和发布',
        run: () => go({ name: 'catalogManagement' }),
      },
    ];
    const viewport = actionViewport(actions, policy.mode === 'compact', focus, scrollOffset, responsiveBudget(8, 12));
    const sourceCount = Math.max(0, actions.length - 3);
    content = <Box flexDirection="column"><SemanticRows actions={actions} focus={focus} kind={focus < sourceCount ? 'section' : 'action'} compact={policy.mode === 'compact'} offset={viewport.offset} limit={viewport.limit} /></Box>;
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
        : activeVersion
        ? `当前 AW 缺少 ${freshness.missingCapabilities?.length ?? 0} 项待检查版本所需功能；当前目录版本 ${activeVersion} 仍可浏览和使用。`
        : `当前 AW 缺少 ${freshness.missingCapabilities?.length ?? 0} 项待检查版本所需功能；这个来源没有可用目录版本。`
      : freshness?.state === 'checkFailed' && activeVersion
      ? `更新检查失败，但当前目录版本 ${activeVersion} 仍可浏览和使用。`
      : freshness?.state === 'updateAvailable'
        ? `当前使用 ${activeVersion ?? '未启用'}；待检查版本 ${candidateVersion ?? '未知'} 可更新。`
        : freshness?.state === 'localChangesAvailable'
          ? '本地插件目录内容已变化；确认前仍使用当前启用版本。'
          : activeVersion ? `当前使用目录版本 ${activeVersion}。`
      : generationState === 'stateInvalid' ? '目录版本状态无效。确认恢复后可以重新启用这个来源。'
        : generationState === 'repairRequired' ? combinedRepairAndMismatch
          ? '当前目录版本损坏，且来源配置已变化。验证待检查版本后可精确修复同一版本，或明确切换到新版本。'
          : '当前目录版本缺失或损坏。可在这里精确修复。'
        : generationState === 'configMismatch' ? '来源配置与当前启用版本不一致。可验证待检查版本并切换。'
          : logicalIdentityChanged ? '来源发布身份已变化。请编辑来源，或移除后重新添加。'
            : '来源没有可用的启用版本。可在这里取得并启用。';
    help = '↑↓ 移动 · Enter 选择 · Esc 返回';
    const generationAction: ActionItem[] = logicalIdentityChanged ? []
      : generationState === 'incompatible' ? [{
          label: '查看不兼容详情',
          description: '显示所需和缺少的功能支持',
          status: 'error',
          run: () => go({ name: 'sourceTechnical', sourceId: route.sourceId }),
        }]
      : generationState === 'repairRequired' ? [{
          label: '重新下载旧版本并精确修复',
          description: '使用当前启用版本的精确提交；成功后保持此版本',
          disabled: activationBlocked ? `请先处理：${sourceOperationBlockLabel(activationBlocked)}` : undefined,
          run: () => beginReview({
            kind: 'catalogGeneration',
            action: 'repair',
            sourceId: route.sourceId,
          }),
        }, ...(freshness?.state === 'incompatible' ? [] : [{
          label: '使用待检查版本替换损坏版本…',
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
              label: freshness.state === 'localChangesAvailable'
                ? '应用本地内容变化…' : `更新到 ${candidateVersion ?? '待检查版本'}…`,
              description: '进入确认；确认前不会切换当前版本',
              disabled: activationBlocked ? `请先处理：${sourceOperationBlockLabel(activationBlocked)}` : undefined,
              run: () => beginReview({ kind: 'catalogGeneration', action: 'update', sourceId: route.sourceId }),
            }]
          : freshness?.state === 'versionConflict'
            || freshness?.state === 'rollbackDetected'
            || freshness?.state === 'incompatible'
            ? [{
                label: freshness.state === 'versionConflict' ? '查看版本冲突'
                  : freshness.state === 'rollbackDetected' ? '查看回退详情' : '查看不兼容详情',
                description: '普通更新已阻止；当前启用版本保持不变',
                status: 'error',
                run: () => go({ name: 'sourceTechnical', sourceId: route.sourceId }),
              }]
            : [{
                label: freshness?.state === 'checking' ? '正在检查…' : '重新检查',
                description: '轻量检查这个来源；提交发生变化时才完整验证',
                disabled: freshness?.state === 'checking' ? '检查正在进行' : undefined,
                run: () => props.controller.recheckCatalogSource(route.sourceId),
              }];
    const managementActions: ActionItem[] = [
      { label: '编辑来源…', description: '集中修改地址、引用、子目录和自动检查', run: () => openSourceEdit(route.sourceId) },
      ...(generationState === 'incompatible'
        || (freshness?.state === 'incompatible' && generationState !== 'ready') ? [] : [{
        label: generationState === 'ready' ? '设为主来源…' : '启用并设为主来源…',
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
      { label: '移除来源…', description: '移除来源配置', status: 'error', disabled: detail?.primary ? '主来源不能直接移除' : undefined, run: () => beginReview({ kind: 'sourceMutation', action: 'remove', sourceId: route.sourceId, changes: [{ title: `移除来源 ${route.sourceId}` }] }) },
      { label: '技术详情', description: '查看脱敏错误代码和当前版本证据', run: () => go({ name: 'sourceTechnical', sourceId: route.sourceId }) },
      ...(generationState !== 'ready'
        || freshness?.state === 'updateAvailable'
        || freshness?.state === 'localChangesAvailable'
        || freshness?.state === 'versionConflict'
        || freshness?.state === 'rollbackDetected'
        || freshness?.state === 'incompatible' ? [{
        label: freshness?.state === 'checking' ? '正在检查…' : '重新检查',
        description: '轻量检查这个来源；提交发生变化时才完整验证',
        disabled: freshness?.state === 'checking' ? '检查正在进行' : undefined,
        run: () => props.controller.recheckCatalogSource(route.sourceId),
      }] : []),
      {
        label: '完整验证',
        description: '强制重新取得并完整验证这个来源',
        disabled: freshness?.state === 'checking' ? '检查正在进行' : undefined,
        run: () => props.controller.fullValidateCatalogSource(route.sourceId),
      },
    ];
    actions = [
      ...generationAction.slice(0, 1),
      managementActions[0]!,
      {
        label: '更多处理方式…',
        description: '设为主来源、移除、精确修复、替换、重新检查和完整验证',
        run: () => go({ name: 'sourceMore', sourceId: route.sourceId }),
      },
    ];
    const sourceActionViewport = actionViewport(actions, policy.mode === 'compact', focus, scrollOffset, responsiveBudget(2, 5));
    const freshnessLabel = catalogSourceFreshnessLabel(freshness);
    content = <Box flexDirection="column"><SectionCard title="当前目录版本" status={generationState === 'incompatible' ? 'error' : activeVersion ? 'success' : 'warning'} compact={policy.mode === 'compact'}><StaticRow title={activeVersion ? `版本 ${activeVersion}` : '未启用'} meta={activeVersion ? generation?.active?.digestShort : catalogGenerationStateLabel(generationState)} status={generationState === 'incompatible' ? 'error' : undefined} compact />{candidateVersion ? <StaticRow title={`待检查版本 ${candidateVersion}`} meta={freshnessLabel} status={freshness?.state === 'updateAvailable' || freshness?.state === 'localChangesAvailable' ? 'warning' : undefined} compact /> : <StaticRow title={freshnessLabel} status={freshness?.state === 'checkFailed' ? 'warning' : undefined} compact />}</SectionCard><SectionCard title="来源配置" compact={policy.mode === 'compact'}><StaticRow title="位置" meta={detail?.locationSummary ?? '不可用'} compact /><StaticRow title="引用" meta={generation?.active?.requestedRef ?? detail?.explicitRef ?? detail?.requestedRef ?? '本地目录'} compact /><StaticRow title="自动检查更新" meta={detail?.autoCheck === false ? '关闭' : '开启'} compact /></SectionCard><SemanticRows actions={actions} focus={focus} kind="action" compact={policy.mode === 'compact'} offset={sourceActionViewport.offset} limit={sourceActionViewport.limit} /></Box>;
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
        label: '使用待检查版本替换损坏版本…',
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
        label: freshness.state === 'localChangesAvailable' ? '应用本地内容变化…'
          : `更新到 ${freshness.candidate?.catalogVersion ?? '待检查版本'}…`,
        description: '确认前不会切换当前版本',
        disabled: blocked,
        run: () => beginReview({ kind: 'catalogGeneration', action: 'update', sourceId: route.sourceId }),
      }] : []),
      {
        label: generationState === 'ready' ? '设为主来源…' : '启用并设为主来源…',
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
      { label: '移除来源…', description: '检查当前、历史和未知引用后再确认', status: 'error',
        disabled: detail?.primary ? '主来源不能直接移除' : undefined,
        run: () => beginReview({ kind: 'sourceMutation', action: 'remove', sourceId: route.sourceId,
          changes: [{ title: `移除来源 ${route.sourceId}` }] }) },
      { label: freshness?.state === 'checking' ? '正在检查…' : '重新检查',
        description: '轻量检查这个来源；不会自动启用更新',
        disabled: freshness?.state === 'checking' ? '检查正在进行' : undefined,
        run: () => props.controller.recheckCatalogSource(route.sourceId) },
      { label: '完整验证', description: '强制重新取得并完整验证这个来源',
        disabled: freshness?.state === 'checking' ? '检查正在进行' : undefined,
        run: () => props.controller.fullValidateCatalogSource(route.sourceId) },
      { label: '技术详情', description: '查看脱敏错误代码和版本证据',
        run: () => go({ name: 'sourceTechnical', sourceId: route.sourceId }) },
    ];
    const viewport = actionViewport(actions, policy.mode === 'compact', focus, scrollOffset, pageActionBudget(1));
    content = <SemanticRows actions={actions} focus={focus} kind="action" compact={policy.mode === 'compact'} offset={viewport.offset} limit={viewport.limit} />;
  } else if (route.name === 'sourceTechnical') {
    const overview = props.controller.getSourceOverview(route.sourceId);
    const detail = overview.detail;
    const state = overview.health?.state ?? overview.source?.state;
    const diagnostic = sourceDiagnostic(
      route.sourceId,
      state,
      detail,
      props.controller.getCatalogGeneration(route.sourceId),
      props.controller.getCatalogFreshness(route.sourceId),
    ) ?? {
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
    help = 'PgUp/PgDn 查看全部技术详情 · Enter 返回 · Esc 返回';
    actions = [{ label: '返回来源详情', run: back }];
    content = <Box flexDirection="column"><DiagnosticSummary diagnostic={diagnostic} technical compact={policy.mode === 'compact'} offset={batchTargetOffset} limit={responsiveBudget(5, 10)} /><SemanticRows actions={actions} focus={focus} kind="action" compact={policy.mode === 'compact'} /></Box>;
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
      title = '选择版本来源'; description = 'Release 和 Beta 是固定 Git ref 的显示预设。';
      const useRefPreset = async (refPolicy: SourceDraft['refPolicy'], ref: string): Promise<void> => {
        const next = { ...sourceDraft, refPolicy, ref };
        setSourceDraft(next);
        setDirty(true);
        if (route.returnToDraft) acceptSourceFieldAndBack();
        else go({ name: 'sourceAdd', step: 'subdir', owner: route.owner });
      };
      actions = [
        { label: '跟随 AW CLI', description: `当前 CLI ${snapshot.cliChannel === 'beta' ? 'beta' : 'release'} → catalog/${snapshot.cliChannel === 'beta' ? 'beta' : 'latest'}`, selected: sourceDraft.refPolicy === 'cliChannel', run: () => { const policy = catalogRefPolicyForPreset('followCli')!; return useRefPreset(policy.type, ''); } },
        { label: 'Release', description: '固定读取 catalog/latest', selected: sourceDraft.refPolicy === 'explicit' && sourceDraft.ref === CATALOG_LATEST_REF, run: () => { const policy = catalogRefPolicyForPreset('release')!; return useRefPreset(policy.type, policy.type === 'explicit' ? policy.ref : ''); } },
        { label: 'Beta', description: '固定读取 catalog/beta', selected: sourceDraft.refPolicy === 'explicit' && sourceDraft.ref === CATALOG_BETA_REF, run: () => { const policy = catalogRefPolicyForPreset('beta')!; return useRefPreset(policy.type, policy.type === 'explicit' ? policy.ref : ''); } },
        { label: '指定 Git ref…', description: 'branch、tag、完整 ref 或 commit', selected: sourceDraft.refPolicy === 'explicit' && sourceDraft.ref !== CATALOG_LATEST_REF && sourceDraft.ref !== CATALOG_BETA_REF, run: () => {
          if (route.returnToDraft) props.controller.replace({ name: 'sourceAdd', step: 'ref', owner: route.owner, returnToDraft: true });
          else go({ name: 'sourceAdd', step: 'ref', owner: route.owner });
        } },
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
    description = '地址、引用、子目录和自动检查组成一个草稿；保存前统一 Review。';
    const locationSummary = draft
      ? projectCatalogSourceLocation(draft.location)
      : detail?.locationSummary ?? '不可用';
    const setOfficialLocation = (location: string): void => {
      const current = draft ?? (() => {
        const source = props.controller.getConfiguredSource(route.sourceId);
        if (!source) return undefined;
        return sourceDraftFromSource(source, `source-update:${route.sourceId}:${Date.now()}`);
      })();
      if (!current || current.type !== 'git' || current.location === location) return;
      const next = { ...current, location };
      setSourceDraft(next);
      setDirty(true);
      props.controller.replace({ name: 'sourceEdit', sourceId: route.sourceId, owner: next.owner });
    };
    actions = [
      ...(route.sourceId === 'official' && (draft?.type === 'git' || !draft && detail?.type === 'git') ? [
        { label: 'HTTPS', description: '使用系统 Git credential helper', selected: locationSummary === projectCatalogSourceLocation(OFFICIAL_CATALOG_SOURCE_URL), run: () => setOfficialLocation(OFFICIAL_CATALOG_SOURCE_URL) },
        { label: 'SSH', description: '使用本机 SSH key；Git 连接使用 BatchMode', selected: locationSummary === projectCatalogSourceLocation(OFFICIAL_CATALOG_SOURCE_SSH_URL), run: () => setOfficialLocation(OFFICIAL_CATALOG_SOURCE_SSH_URL) },
      ] : [{ label: draft?.type === 'path' || detail?.type === 'path' ? '本地目录' : 'Git 仓库地址', description: locationSummary, run: () => startDraftField('location') }]),
      ...(draft?.type === 'git' || !draft && detail?.type === 'git' ? [
        { label: '版本引用', description: draft ? draft.refPolicy === 'explicit' ? `固定：${draft.ref}` : '跟随 AW 版本通道' : detail?.refPolicy === 'explicit' ? `固定：${detail.explicitRef}` : '跟随 AW 版本通道', run: () => startDraftField('refPolicy') },
        { label: 'Catalog 子目录', description: draft?.subdir || detail?.subdir || '未设置', run: () => startDraftField('subdir') },
      ] : []),
      { label: '自动检查更新', description: (draft?.autoCheck ?? detail?.autoCheck) ? '已开启' : '已关闭', selected: draft?.autoCheck ?? detail?.autoCheck, run: () => {
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
    content = <Box flexDirection="column"><SectionCard title="来源草稿" compact={policy.mode === 'compact'}>
      <StaticRow title="来源 ID" meta={draft?.sourceId ?? route.sourceId} compact />
      <StaticRow title="类型" meta={(draft?.type ?? detail?.type) === 'git' ? 'Git 仓库' : '本地目录'} compact />
    </SectionCard><SemanticRows actions={actions} focus={focus} kind="section" compact={policy.mode === 'compact'} />
      {route.sourceId === 'official' && detail?.type === 'git' ? <SectionCard title="来源身份">
        <StaticRow title="逻辑 Catalog" meta="lesliechan721-arch/agent-workflow" />
        <StaticRow title="source identity" meta="HTTPS / SSH 保持一致" />
        <StaticRow title="明文 HTTP" meta="不支持" status="warning" />
      </SectionCard> : null}
    </Box>;
  } else if (route.name === 'sourceSave' && sourceDraft?.owner === route.owner) {
    const changes = sourceDraftChanges(sourceDraft);
    breadcrumb = `插件来源 / ${sourceDraft.sourceId} / 修改汇总`;
    context = `${changes.length} 项未保存`;
    title = sourceDraft.mode === 'add' ? `保存新来源 ${sourceDraft.sourceId}？` : `保存 ${sourceDraft.sourceId} 的修改？`;
    description = '选择是否在保存后验证候选并启用。保存成功与启用成功会分别报告。';
    actions = [
      { label: '保存并启用', description: '保存来源配置，再验证并切换当前目录版本', status: 'success', run: () => beginSourceReview(sourceDraft, true) },
      { label: '只保存', description: '只保存来源配置；当前目录版本保持不变', run: () => beginSourceReview(sourceDraft, false) },
      { label: '返回修改', run: back },
    ];
    content = <Box flexDirection="column"><SectionCard title="来源变化" compact={policy.mode === 'compact'}>
      {changes.map((change) => <ReviewChangeRow key={change.title} title={`~ ${change.title}`} description={`${change.before ?? '未设置'} → ${change.after}`} compact />)}
    </SectionCard><SemanticRows actions={actions} focus={focus} kind="action" compact={policy.mode === 'compact'} /></Box>;
  } else if (route.name === 'scriptTimeout' && pendingReviewIntent) {
    breadcrumb = '高级选项 / 安装前检查脚本';
    context = '毫秒';
    title = '设置脚本超时';
    description = `输入 ${SCRIPT_TIMEOUT_MIN_MS}–${SCRIPT_TIMEOUT_MAX_MS} 毫秒。默认 ${SCRIPT_TIMEOUT_DEFAULT_MS} 毫秒。`;
    help = '输入 · Enter 应用并重新准备 Review · Ctrl-U 清空 · Esc 取消';
    content = <Box flexDirection="column">
      <InputCard focused title={<InputDisplay value={scriptTimeoutInput} columns={Math.max(8, size.columns - 8)} />} description={scriptTimeoutError ?? '此值将绑定本次 Review。'} status={scriptTimeoutError ? 'error' : undefined} />
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
    const referenceLimit = Math.max(1, pageActionBudget(10));
    const references = sourceReferenceSummary?.dependencies ?? [];
    const referenceOffset = Math.min(batchTargetOffset, Math.max(0, references.length - 1));
    const visibleReferences = references.slice(referenceOffset, referenceOffset + referenceLimit);
    const hiddenReferences = Math.max(0, references.length - referenceOffset - visibleReferences.length);
    if (sourceDependenciesExpanded && references.length > referenceLimit) {
      help = 'PgUp/PgDn 查看全部引用 · ↑↓ 移动 · Enter 选择 · Esc 返回';
    }
    content = <Box flexDirection="column"><Callout status="error" title={sourceReferenceSummary?.inventoryComplete === false ? '引用清单不完整' : '发现活动引用'} /><SectionCard title="引用汇总"><StaticRow title="安装位置" meta={countLabel(sourceReferenceSummary?.installationCount, '个')} /><StaticRow title="插件设置" meta={countLabel(sourceReferenceSummary?.configCount, '份')} /><StaticRow title="生命周期意图" meta={countLabel(sourceReferenceSummary?.lifecycleCount, '项')} /><StaticRow title="Marketplace" meta={countLabel(sourceReferenceSummary?.marketplaceCount, '个')} />{sourceDependenciesExpanded && referenceOffset > 0 ? <StaticRow title={`↑ 前面还有 ${referenceOffset} 项`} status="muted" compact /> : null}{sourceDependenciesExpanded ? visibleReferences.map((dependency, index) => <StaticRow key={`${dependency.category}:${dependency.pluginId ?? dependency.sourceId ?? referenceOffset + index}`} title={`${dependency.category} · ${dependency.pluginId ?? dependency.sourceId ?? '身份未知'}`} meta={`${dependency.platform ? platformLabel(dependency.platform) : ''}${dependency.scope ? ` · ${scopeLabel(dependency.scope)}` : ''}`} />) : null}{sourceDependenciesExpanded && hiddenReferences > 0 ? <StaticRow title={`↓ 后面还有 ${hiddenReferences} 项`} status="muted" compact /> : null}</SectionCard><SemanticRows actions={actions} focus={focus} kind="action" compact={policy.mode === 'compact'} /></Box>;
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
    const issuePlugin = issue.pluginId ? props.controller.getPluginOverview(issue.pluginId) : undefined;
    const issueOverview = issue.pluginId ? props.controller.getPluginDependencyOverview(issue.pluginId) : undefined;
    const issueDiagnosticSummary = <DiagnosticSummary
      diagnostic={issue.diagnostic}
      technical={showTechnical}
      offset={showTechnical ? batchTargetOffset : undefined}
      limit={showTechnical ? responsiveBudget(5, 10) : undefined}
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
        ...(issueHasTechnicalDetails ? [{ label: showTechnical ? '隐藏技术详情' : '技术详情', run: () => toggleTechnical() }] : []),
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
    context = '只读 · 已脱敏';
    title = detail ? '安全技术详情' : '操作记录已不可用';
    description = detail
      ? '可滚动查看所有目标、阶段、代码和已保留的安全原因。'
      : '这项会话记录已经不再可用。';
    const preview = detail ? props.controller.previewOperationReport(route.recordId) : undefined;
    actions = detail ? [
      preview
        ? { label: '预览安全报告', description: '确认内容后选择本地保存位置', run: () => go({ name: 'operationReportPreview', recordId: route.recordId }) }
        : { label: '报告当前不可用', disabled: '无法生成这项记录的报告' },
      { label: '返回操作记录', run: back },
    ] : [{ label: '返回操作记录', run: back }];
    const detailLineLimit = policy.mode === 'compact' ? 2 : Math.max(1, pageActionBudget(5));
    content = detail ? <Box flexDirection="column">
      <OperationDiagnosticScreen
        detail={detail}
        compact={policy.mode === 'compact'}
        offset={scrollOffset}
        limit={detailLineLimit}
      />
      <SemanticRows actions={actions} focus={focus} kind="action" compact={policy.mode === 'compact'} />
    </Box> : <Box flexDirection="column">
      <Callout status="warning" title="记录已不可用" description="返回操作记录后可查看仍在本次会话中的结果。" />
      <SemanticRows actions={actions} focus={focus} kind="action" compact={policy.mode === 'compact'} />
    </Box>;
  } else if (route.name === 'operationReportPreview') {
    const preview = props.controller.previewOperationReport(route.recordId);
    breadcrumb = '操作记录 / 报告预览';
    context = '只读预览';
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
      actions = [
        { label: '选择本地保存位置…', description: '保存前输入明确的文件路径', run: () => {
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
        { label: '返回技术详情', run: back },
      ];
      const reportLineLimit = policy.mode === 'compact' ? 2 : Math.max(1, pageActionBudget(5));
      const reportActionViewport = actionViewport(
        actions,
        policy.mode === 'compact',
        focus,
        scrollOffset,
        pageActionBudget(5),
      );
      content = <Box flexDirection="column">
        <OperationReportPreviewScreen
          preview={preview}
          compact={policy.mode === 'compact'}
          offset={scrollOffset}
          limit={reportLineLimit}
        />
        {reportSaveResult ? <Callout status="success" title="报告已保存" description={reportSaveResult} compact={policy.mode === 'compact'} /> : null}
        {reportSaveError ? <Callout status="error" title="报告未保存" description={reportSaveError} compact={policy.mode === 'compact'} /> : null}
        <SemanticRows actions={actions} focus={focus} kind="action" compact={policy.mode === 'compact'} offset={reportActionViewport.offset} limit={reportActionViewport.limit} />
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
      : preparation.operationKind === 'configSave' || preparation.operationKind === 'configReset'
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
    const installReviewPluginId = pendingReviewIntent?.kind === 'pluginWrite'
      && pendingReviewIntent.action === 'install'
      ? pendingReviewIntent.pluginId
      : review.pluginAction === 'install' ? snapshot.installPlacementDraft?.pluginId : undefined;
    const batchReview = review.operationKind === 'pluginWriteBatch';
    const taskReview = review.operationKind === 'pluginWriteTask';
    const catalogManagementReview = review.operationKind === 'catalogManagement';
    const sharedImpactConfirmed = !review.requiresConfirmation
      || confirmedSharedReviewToken === review.reviewToken;
    breadcrumb = `${review.subject.name} / ${review.title}`;
    title = `${snapshot.result?.state === 'stale' ? '状态已变化 · ' : ''}${review.operationKind === 'portableInstall' || taskReview
      ? review.title : `确认${review.title}`} ${review.subject.name}`;
    description = snapshot.result?.state === 'stale'
      ? '当前状态已变化。请检查新的变化后再次确认。'
      : review.requiresConfirmation ? '' : review.description;
    if (taskReview) {
      context = '精确目标 · 用户任务';
      help = 'PgUp/PgDn 查看全部影响 · ↑↓ 移动 · Enter 选择 · Esc 返回';
    } else if (batchReview) {
      context = `${review.batch?.requestedPluginIds.length ?? 0} 个根插件 · ${review.batch?.groupCount ?? 0} 组`;
      help = 'PgUp/PgDn 查看全部根插件和依赖 · ↑↓ 移动 · Enter 选择 · Esc 返回';
    }
    actions = [
      ...(review.requiresConfirmation ? [{
        label: catalogManagementReview
          ? sharedImpactConfirmed ? '已确认本次写入' : '确认本次写入'
          : sharedImpactConfirmed ? '已确认共享影响' : '确认共享影响',
        description: catalogManagementReview
          ? '我已检查上方的精确写入、远端影响和保留项。'
          : review.sharedImpact.warning ?? '此操作会修改多个插件共同使用的 Codex 平台内容',
        selected: sharedImpactConfirmed,
        run: () => {
          setConfirmedSharedReviewToken(review.reviewToken);
          setFocus(1);
        },
      }] : []),
      { label: review.primaryLabel, description: '执行前将再次检查当前状态', status: review.destructive ? 'error' : undefined, disabled: sharedImpactConfirmed ? undefined : '请先确认共享影响', run: () => {
        if (operationBusy.current) return;
        operationBusy.current = true;
        return props.controller.executeOperation(review.reviewToken).then(() => {
          setFocus(0);
          setScrollOffset(0);
        }).finally(() => {
          operationBusy.current = false;
        });
      } },
      ...(installReviewPluginId
        && (snapshot.installPlacementDraft?.targets.length ?? 0) > 0 ? [{
          label: '查看/调整依赖位置',
          description: '当前已采用 planner 推荐位置；调整后会重新建立 Review',
          run: () => {
            props.controller.push({
              name: 'dependencyPlacement',
              pluginId: installReviewPluginId,
            });
            setFocus(0);
            setScrollOffset(0);
          },
        }] : []),
      ...(sharedImpactConfirmed && (pendingReviewIntent?.kind === 'pluginWrite'
        && (pendingReviewIntent.action === 'install'
          || pendingReviewIntent.action === 'refreshAndSync'
          || pendingReviewIntent.action === 'reinstall'
          || pendingReviewIntent.action === 'sync')
        || pendingReviewIntent?.kind === 'pluginWriteBatch'
          && (pendingReviewIntent.action === 'install'
            || pendingReviewIntent.action === 'sync'
            || pendingReviewIntent.action === 'reinstall')
        || pendingReviewIntent?.kind === 'pluginWriteTask'
        || pendingReviewIntent?.kind === 'configSave' && pendingReviewIntent.apply) ? [{
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
    const compressedReview = policy.mode === 'compact' || review.requiresConfirmation;
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
    const visibleSpecs = groupedSpecs.filter((group) => group.changes.length > 0
      && !technicalGroups.has(group.key));
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
    const batchChangeLimit = Math.max(1, responsiveBudget(6, 10) - actions.length);
    const batchChanges = review.changes.slice(batchTargetOffset, batchTargetOffset + batchChangeLimit);
    const batchHiddenBefore = batchTargetOffset;
    const prioritizedReviewChanges = [
      ...review.changes.filter((change) => change.kind === 'warning'),
      ...review.changes.filter((change) => change.kind !== 'warning'),
    ];
    const pagedReviewChanges = prioritizedReviewChanges.slice(batchTargetOffset,
      batchTargetOffset + batchChangeLimit);
    const changeGroups = batchReview || review.changes.length > staticRowBudget
      ? <Box flexDirection="column">
          {batchHiddenBefore > 0 ? <StaticRow title={`↑ 前面还有 ${batchHiddenBefore} 项`} status="muted" compact /> : null}
          {(batchReview ? batchChanges : pagedReviewChanges).map((change, index) => <ReviewChangeRow
            key={`${change.batchGroupId ?? ''}:${change.pluginId ?? change.title}:${index}`}
            title={`${change.sourceId ? `${change.sourceId} · ` : ''}${change.relation === 'requested' ? '根插件' : change.relation === 'direct' ? '直接依赖' : change.relation === 'transitive' ? '间接依赖' : ''} ${reviewSymbol(change)} ${change.title}`}
            meta={change.description}
            status={changeStatus(change)}
            compact
          />)}
          {Math.max(0, review.changes.length - batchTargetOffset - (batchReview ? batchChanges : pagedReviewChanges).length) > 0 ? <StaticRow title={`↓ 后面还有 ${Math.max(0, review.changes.length - batchTargetOffset - (batchReview ? batchChanges : pagedReviewChanges).length)} 项`} status="muted" compact /> : null}
        </Box>
      : standardChangeGroups;
    const technicalDetails = review.technicalDetails ?? [];
    const technicalDetailLimit = responsiveBudget(1, 3);
    const visibleTechnicalDetails = technicalDetails.slice(batchTargetOffset,
      batchTargetOffset + technicalDetailLimit);
    const hiddenTechnicalDetails = Math.max(0,
      technicalDetails.length - batchTargetOffset - visibleTechnicalDetails.length);
    const technicalCardRows = 3 + visibleTechnicalDetails.length;
    const technicalChangeBudget = Math.max(1,
      size.rows - 8 - 3 - (review.equivalentCommand ? 1 : 0) - actions.length - technicalCardRows);
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
        title={`${category ? `${category} · ` : ''}${reviewSymbol(change)} ${change.title}${change.description ? ` · ${change.description}` : ''}`}
        meta={index === visibleTechnicalChanges.length - 1 && hiddenTechnicalChanges > 0
          ? `另有 ${hiddenTechnicalChanges} 项` : undefined}
        status={changeStatus(change)}
        compact
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
    if (review.changes.length > staticRowBudget || showTechnical
      && (review.changes.length > technicalChangeBudget || technicalDetails.length > technicalDetailLimit)) {
      help = 'PgUp/PgDn 查看全部确认信息 · ↑↓ 移动 · Enter 选择 · Esc 返回';
    }
    content = <Box flexDirection="column"><ReviewCard title={review.requiresConfirmation ? undefined : review.subject.name} meta={review.requiresConfirmation ? undefined : `${review.subject.sourceLabel ?? ''} ${review.subject.version ?? ''}`} description={showEquivalentCommand ? review.description : undefined}>{showEquivalentCommand ? <Text>等价命令：{review.equivalentCommand}</Text> : null}{showTechnical && review.catalogBinding ? <><StaticRow title={`Catalog：${review.catalogBinding.sourceId} ${review.catalogBinding.catalogVersion} · 当前使用`} meta={`generation ${review.catalogBinding.generationDigestShort}`} status="success" compact /><StaticRow title="操作期间不检查远端 Catalog" status="success" compact /></> : null}{installDependencyPluginIds.size > 0 ? <><StaticRow
      title={`需要 ${installDependencyPluginIds.size} 个额外插件；${reusedDependencyPluginIds.size} 个复用、${newDependencyCount} 个新增`}
      status="info" compact /><StaticRow
      title={widenedDependencyCount > 0 ? `${widenedDependencyCount} 个依赖会扩大到所有项目` : '没有依赖会扩大到所有项目'}
      status={widenedDependencyCount > 0 ? 'warning' : 'success'} compact /></> : null}{review.requiresConfirmation ? <StaticRow title={catalogManagementReview ? '! 需要确认本次写入' : '! 需要确认共享影响'} meta={!catalogManagementReview && review.sharedImpact.pluginIds.length > 0 ? `${review.sharedImpact.pluginIds.length} 个插件` : undefined} description={catalogManagementReview ? review.description : review.sharedImpact.warning} status="warning" compact /> : null}{showTechnical ? technicalChanges : changeGroups}<SemanticRows actions={actions} focus={focus} kind="action" compact />{compressedReview || showTechnical ? null : <StaticRow title="技术详情（d）" status="muted" />}{showTechnical ? <TechnicalDetails>{visibleTechnicalDetails.map((detail, index) => <StaticRow key={detail} title={detail} meta={index === visibleTechnicalDetails.length - 1 && hiddenTechnicalDetails > 0 ? `另有 ${hiddenTechnicalDetails} 项` : undefined} compact />)}</TechnicalDetails> : null}</ReviewCard></Box>;
  } else if (route.name === 'progress') {
    const taskOperation = snapshot.activeReview?.operationKind === 'pluginWriteTask';
    const catalogManagementOperation = snapshot.activeReview?.operationKind === 'catalogManagement';
    const portableOperation = snapshot.activeReview?.operationKind === 'portableInstall';
    const configOperation = snapshot.activeReview?.operationKind === 'configSave'
      || snapshot.activeReview?.operationKind === 'configReset';
    const sourceOperation = snapshot.activeReview?.operationKind === 'sourceMutation'
      || snapshot.activeReview?.operationKind === 'catalogGeneration'
      || snapshot.activeReview?.operationKind === 'catalogSourcesRecovery';
    const issueOperation = snapshot.activeReview?.originIssue;
    breadcrumb = catalogManagementOperation ? '目录管理 / 进度' : taskOperation ? '插件任务 / 进度' : portableOperation ? '通用 Skills / 进度' : issueOperation ? '需要处理 / 进度' : sourceOperation ? '插件来源 / 保存' : configOperation ? '设置 / 进度' : '插件操作 / 进度';
    const configApply = snapshot.activeReview?.operationKind === 'configSave'
      && snapshot.activeReview.changes.some((change) => change.group === 'configImpact' && change.kind === 'change');
    const catalogGenerationOperation = snapshot.activeReview?.operationKind === 'catalogGeneration';
    const catalogSourcesRecovery = snapshot.activeReview?.operationKind === 'catalogSourcesRecovery';
    title = catalogManagementOperation ? '正在执行 Catalog 管理操作' : taskOperation ? '正在执行插件任务' : portableOperation ? '正在安装通用 Skills' : issueOperation ? '正在处理问题'
      : catalogGenerationOperation ? '正在验证并启用目录版本'
        : catalogSourcesRecovery ? '正在恢复插件来源配置'
        : sourceOperation ? '正在保存来源配置'
          : configOperation ? configApply ? '正在保存并应用设置' : '正在保存设置'
            : '正在执行插件操作';
    description = catalogManagementOperation ? '正在执行已确认的精确 Workspace、Store、开发来源或发布操作。'
      : issueOperation ? '完成后会重新读取状态并检查问题。'
      : catalogGenerationOperation ? '正在验证并应用已确认的目录版本操作。'
        : catalogSourcesRecovery ? '正在备份损坏配置并恢复官方默认来源。'
        : sourceOperation ? '只原子保存来源配置，不访问网络。'
          : configOperation ? configApply ? '先保存所选层，再重新应用当前可见安装位置。' : '只保存所选设置层。'
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
    content = catalogManagementOperation ? <StatusCard status={failedProgress ? 'error' : 'info'} title="Catalog 管理">
      <ProgressRow title="确认计划" meta="完成" state="complete" />
      <ProgressRow title={currentPhase || '准备执行'} description={progress.current?.target} meta={`${elapsedSeconds}s`} state={failedProgress ? 'error' : currentPhase ? 'active' : 'pending'} compact={policy.mode === 'compact'} />
      <ProgressRow title="验证并记录结果" state={validationActive ? 'active' : 'pending'} />
      {!showTechnical && latestMessage ? <StaticRow title={latestMessage} status="muted" compact /> : null}
      {showTechnical ? technicalMessages.map((message, index) => <StaticRow key={`${index}:${message}`} title={message} compact />) : null}
      {exitAfterBusy ? <Callout status="warning" title="操作完成后退出" /> : null}
    </StatusCard> : portableOperation ? <StatusCard status={failedProgress ? 'error' : 'info'} title="Skills CLI">
      <ProgressRow title="检查插件和依赖" description={`${snapshot.activeReview?.subject.name ?? '当前插件'} · ${portableDraft?.dependencySummary?.directCount ?? 0} 个直接依赖`} meta={portableProgressMeta(0)} state={portableProgressState(0)} compact={compactPortableProgress} />
      <ProgressRow title="生成已选候选 Skills" description={`${portableProviderCount} 个来源或依赖插件提供 ${portableSelectedCount} 个 Skills`} meta={portableProgressMeta(1)} state={portableProgressState(1)} compact={compactPortableProgress} />
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
      {dependencyProgress ? <SectionCard title="执行目标" meta={`${snapshot.progressTargets.length} 个目标`}>{progressTargetOffset > 0 ? <StaticRow title={`↑ 前面还有 ${progressTargetOffset} 个目标`} status="muted" compact /> : null}{visibleProgressTargets.map((entry) => {
        const state = progressLabel(entry);
        const relation = entry.relation === 'requested' ? '你选择的插件' : entry.relation === 'direct' ? '直接依赖' : '间接依赖';
        const title = props.controller.getPluginOverview(entry.pluginId)?.displayName
          ?? entry.pluginId.split('/').at(-1);
        return <ResultRow key={`${entry.pluginId}:${entry.platform}:${entry.scope}`} title={title} description={relation} meta={state.label} status={state.status ?? 'muted'} compact={policy.mode === 'compact'} />;
      })}{hiddenProgressTargets > 0 ? <StaticRow title={`${batchProgress ? '↓ 后面还有' : '另有'} ${hiddenProgressTargets} 个目标`} status="muted" compact /> : null}</SectionCard> : null}
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
    const catalogManagementOperation = operationKind === 'catalogManagement';
    const catalogManagementResult = catalogManagementOperation
      ? resultSummary?.catalogManagement : undefined;
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
    const portableInstallFailed = portableReceipt?.failureCode === 'portableSkillsCliInstallFailed';
    const portableOriginIsDetail = 'returnRoute' in result
      && result.returnRoute?.name === 'pluginDetail';
    const configOperation = operationKind === 'configSave' || operationKind === 'configReset'
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
    title = catalogManagementOperation
      ? blocked ? '× Catalog 管理操作未完成'
        : partial ? '! Catalog 管理操作只完成了一部分'
          : catalogManagementResult?.action === 'publishPlan' ? '✓ 发布计划已准备'
            : catalogManagementResult?.action === 'publishApply' ? '✓ Catalog 发布完成'
              : catalogManagementResult?.action === 'storePrune' ? '✓ Store 清理完成'
                : '✓ Catalog 管理操作完成'
      : taskOperation
      ? blocked ? `× 插件${pluginWriteTaskLabel(taskSummary?.goal ?? 'restore')}没有完成`
        : partial ? `! 插件${pluginWriteTaskLabel(taskSummary?.goal ?? 'restore')}只完成了一部分`
          : `✓ 插件${pluginWriteTaskLabel(taskSummary?.goal ?? 'restore')}完成`
      : batchOperation
      ? blocked ? '× 批量操作没有完成'
        : partial ? '! 批量操作只完成了一部分' : `✓ 批量${batchActionLabel(action as BatchPluginWriteAction)}完成`
      : portableOperation
      ? blocked ? '× 通用 Skills 安装被阻止'
        : partial ? '! 通用 Skills 结果未完全完成' : '✓ 通用 Skills 已安装'
      : blocked && result.writeMayHaveCompleted
      ? '× 写入结果未确认'
      : issueOperation
      ? blocked || partial ? '× 问题仍未解决' : '✓ 问题已处理'
      : sourceOperation
      ? blocked ? '× 来源操作未完成'
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
    description = catalogManagementOperation
      ? blocked ? result.message : resultSummary?.message ?? 'Catalog 状态已更新。'
      : taskOperation
      ? blocked ? '任务被安全阻止。已完成和未完成目标按实际结果保留。'
        : partial ? `${taskSummary?.retryTargets?.length ?? 0} 个失败目标可重试 · ${taskBlockedCount} 个目标需要决定。`
          : `${taskSummary?.rootResults.length ?? 0} 个根插件已完成。`
      : batchOperation
      ? blocked
        ? '批量写入被阻止。已完成和未完成目标按实际结果保留。'
        : partial
          ? (resultSummary?.batch?.retryTargets?.length ?? 0) > 0
            ? `${resultSummary?.batch?.failedRequestedPluginIds.length ?? 0} 个根插件失败，涉及 ${resultSummary?.batch?.retryTargets?.length ?? 0} 个位置。成功目标不会重放。`
            : '失败目标无法精确定位。请查看本次记录后重新操作。'
          : `${resultSummary?.batch?.requestedPluginIds.length ?? 0} 个根插件已完成。`
      : portableOperation
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
        : partial ? resultSummary?.message ?? '来源配置已保存，但 Catalog 尚未启用。可立即重试。'
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
    const configRetryAvailable = resultSummary?.configApplyRetryAvailable === true
      && resultSummary.configScope !== undefined && configResultPluginId !== undefined;
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
            || operationKind === 'pluginWriteTask' || operationKind === 'catalogManagement'
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
    const preparedPublication = catalogManagementResult?.action === 'publishPlan'
      && catalogManagementResult.planDigest && catalogManagementResult.publication
      ? catalogManagementResult : undefined;
    actions = catalogManagementOperation
      ? [
          ...(preparedPublication ? [{
            label: '应用此发布计划…',
            description: '进入独立确认；取消确认不会写入远端',
            status: 'success' as const,
            run: () => beginReview({
              kind: 'catalogManagement',
              action: 'publishApply',
              expectedPlanDigest: preparedPublication.planDigest!,
              ...(catalogPublishDraft.target
                ? catalogPublishDraft.targetKind === 'remote'
                  ? { remote: catalogPublishDraft.target }
                  : { remoteUrl: catalogPublishDraft.target }
                : {}),
              branch: catalogPublishDraft.branch,
            }, { name: 'catalogPublish', step: 'overview' }),
          }] : []),
          { label: catalogManagementResult?.action === 'storePrune' ? '返回本地存储'
              : catalogManagementResult?.action === 'devActivate' || catalogManagementResult?.action === 'devDeactivate' ? '返回开发来源'
                : catalogManagementResult?.action === 'publishPlan' || catalogManagementResult?.action === 'publishApply' ? '返回发布管理'
                  : '返回 Catalog 工作区',
            run: () => leaveResult(catalogManagementResult?.action === 'storePrune'
              ? { name: 'catalogStore' }
              : catalogManagementResult?.action === 'devActivate' || catalogManagementResult?.action === 'devDeactivate'
                ? { name: 'catalogDev' }
                : catalogManagementResult?.action === 'publishPlan' || catalogManagementResult?.action === 'publishApply'
                  ? { name: 'catalogPublish', step: 'overview' }
                  : 'returnRoute' in result && result.returnRoute ? result.returnRoute
                    : { name: 'catalogManagement' }) },
          { label: '查看本次记录', run: () => result.operationRecordId
            && go({ name: 'operationDiagnostic', recordId: result.operationRecordId }) },
        ]
      : taskOperation
      ? [
          ...(nestedTaskReturn && taskReturnRoute ? [{
            label: '返回剩余恢复任务',
            description: '保留父任务的冻结目标；返回后重新读取当前证据',
            status: 'success' as const,
            run: () => leaveResult(taskReturnRoute),
          }] : []),
          ...((partial || blocked) && (taskSummary?.retryTargets?.length ?? 0) > 0 ? [{
            label: `继续处理剩余 ${taskSummary!.retryTargets!.length} 项…`,
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
            label: '仅重试失败目标…',
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
          ...(configRetryAvailable ? [{
            label: '重试应用',
            description: '先重新进入 Review，并重新采集当前证据',
            run: () => beginReview({
              kind: 'configSave',
              pluginId: configResultPluginId!,
              scope: resultSummary!.configScope!,
              apply: true,
              retryApply: true,
            }),
          }] : []),
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
    }] : []), { label: '返回首页', run: () => requestSessionNavigation('home') }];
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
    const resultActionViewport = actionViewport(actions, true, focus, scrollOffset, pageActionBudget(8));
    const resultExtraRows = (resultSummary?.elapsedMs !== undefined ? 1 : 0)
      + visibleMessages.length
      + visibleChanges.length
      + (partial && hasPreservedTarget && resultTargets.some((target) => target.state === 'skipped') ? 1 : 0);
    const resultTargetLimit = prefixRowLimit(
      prioritizedTargets.map(() => policy.mode === 'compact' ? 1 : 2),
      pageActionBudget() - 3 - resultActionViewport.limit - resultExtraRows,
    );
    const resultTargetOffset = Math.min(batchTargetOffset, Math.max(0, prioritizedTargets.length - 1));
    const visibleResultTargets = prioritizedTargets.slice(
      resultTargetOffset,
      resultTargetOffset + resultTargetLimit,
    );
    const hiddenResultTargets = Math.max(
      0,
      resultTargets.length - resultTargetOffset - visibleResultTargets.length,
    );
    const portableMissingSkills = new Set(portableReceipt?.missing.map((entry) => entry.skill) ?? []);
    const portableSelectedSkills = portableReceipt?.selectedSkills
      ?? snapshot.portableResultSkills
      ?? [];
    const prioritizedPortableSkills = [...portableSelectedSkills].sort((left, right) =>
      Number(portableMissingSkills.has(right)) - Number(portableMissingSkills.has(left)));
    const portableTechnicalSummary = showTechnical && (partial || blocked);
    const portableSkillLimit = showTechnical ? 1 : responsiveBudget(2, 6);
    const portableSkillOffset = Math.min(batchTargetOffset,
      Math.max(0, prioritizedPortableSkills.length - 1));
    const visiblePortableSkills = prioritizedPortableSkills.slice(
      portableSkillOffset,
      portableSkillOffset + portableSkillLimit,
    );
    const hiddenPortableSkills = Math.max(0,
      prioritizedPortableSkills.length - portableSkillOffset - visiblePortableSkills.length);
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
    const resetDispositionText = resultSummary?.resetDisposition === 'absent'
      ? '设置层原本不存在；没有删除内容'
      : resultSummary?.resetDisposition === 'deletedFile'
        ? '已删除设置文件'
        : resultSummary?.resetDisposition === 'unlinkedSymlink'
          ? '已解除设置路径符号链接；链接目标未修改'
          : resultSummary?.resetDisposition === 'quarantinedDirectory'
            ? `设置路径是目录；已隔离为 ${resultSummary.quarantineBasename ?? '安全隔离目录'}`
            : undefined;
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
    const taskResultRows = taskRootResults.flatMap((root) => {
      const rootState = taskRootState(root.state);
      const rootName = props.controller.getPluginOverview(root.pluginId)?.displayName
        ?? root.pluginId.split('/').at(-1)!;
      const requestedTargets = taskSummary?.requestedTargets.filter((target) =>
        target.pluginId === root.pluginId) ?? [];
      return [
        <ResultRow
          key={`root:${root.pluginId}`}
          title={rootName}
          description={`${requestedTargets.length} 个精确安装位置`}
          meta={rootState.label}
          status={rootState.status}
          compact
        />,
        ...requestedTargets.map((target) => {
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
        }),
      ];
    });
    const batchResultRows = (resultSummary?.batch?.rootResults ?? []).map((root) => {
      const rootState = taskRootState(root.state);
      const rootName = props.controller.getPluginOverview(root.pluginId)?.displayName
        ?? root.pluginId.split('/').at(-1)!;
      return <ResultRow
        key={`batch-root:${root.pluginId}`}
        title={rootName}
        description={`${root.targets.length} 个精确安装位置`}
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
    const rootResultRows = taskOperation ? taskResultRows : batchResultRows;
    const taskResultOffset = Math.min(batchTargetOffset, Math.max(0, rootResultRows.length - 1));
    const visibleTaskResultRows = rootResultRows.slice(taskResultOffset, taskResultOffset + taskResultLimit);
    if (taskOperation || batchOperation || resultTargets.length > resultTargetLimit
      || prioritizedPortableSkills.length > portableSkillLimit) {
      help = 'PgUp/PgDn 查看全部项目 · ↑↓ 移动 · Enter 选择 · Esc 返回';
    }
    content = catalogManagementOperation ? <Box flexDirection="column">
      <ResultCard status={resultStatus} title={resultSummary?.message ?? 'Catalog 管理结果'}>
        {catalogManagementResult?.catalogVersion ? <StaticRow title="Catalog 版本" meta={catalogManagementResult.catalogVersion} compact /> : null}
        {catalogManagementResult?.store ? <>
          <StaticRow title="实际删除" meta={`${catalogManagementResult.store.deletedEntries} 项 · ${catalogManagementResult.store.deletedBytes} bytes`} status="success" compact />
          <StaticRow title="实际保留" meta={`${catalogManagementResult.store.retainedEntries} 项`} compact />
        </> : null}
        {catalogManagementResult?.publication ? <>
          <StaticRow title="发布状态" meta={catalogManagementResult.publication.state} status={catalogManagementResult.publication.state === 'uncertain' ? 'warning' : 'success'} compact />
          <StaticRow title="目标" meta={`${catalogManagementResult.publication.remote} · ${catalogManagementResult.publication.branch}`} compact />
          <StaticRow title="计划标识" meta={catalogManagementResult.publication.planDigest.slice(0, 15)} compact />
        </> : catalogManagementResult?.planDigest ? <StaticRow title="计划已准备" meta={catalogManagementResult.planDigest.slice(0, 15)} status="success" compact /> : null}
        {visibleMessages.map((message, index) => <StaticRow key={`${index}:${message}`} title={productResultMessage(message)} status="muted" compact />)}
      </ResultCard>
      <SemanticRows actions={actions} focus={focus} kind="action" compact offset={resultActionViewport.offset} limit={resultActionViewport.limit} />
    </Box> : taskOperation || batchOperation ? <Box flexDirection="column">
      <ResultCard status={resultStatus} title={batchOperation ? '根插件与目标结果' : '根插件结果'}>
        {taskResultOffset > 0 ? <StaticRow title={`↑ 前面还有 ${taskResultOffset} 项`} status="muted" compact /> : null}
        {visibleTaskResultRows}
        {rootResultRows.length > taskResultOffset + visibleTaskResultRows.length
          ? <StaticRow title="↓ 后面还有" meta={`${rootResultRows.length - taskResultOffset - visibleTaskResultRows.length} 项`} status="muted" compact /> : null}
      </ResultCard>
      <SemanticRows actions={actions} focus={focus} kind="action" compact offset={resultActionViewport.offset} limit={resultActionViewport.limit} />
    </Box> : portableOperation ? <Box flexDirection="column">
      {portableTechnicalSummary ? <>
        {portableSkillOffset > 0 ? <StaticRow title={`↑ 前面还有 ${portableSkillOffset} 个 Skills`} status="muted" compact /> : null}
        {portableRows}
        {hiddenPortableSkills > 0 ? <StaticRow title={`另有 ${hiddenPortableSkills} 个 Skills`} status="muted" compact /> : null}
        {portableReceipt?.recovery ? <StaticRow title="安全恢复" meta={portableReceipt.recovery} status="warning" compact /> : null}
        <TechnicalDetails>{compactTechnicalRows}</TechnicalDetails>
      </> : <>
      <ResultCard status={resultStatus} title={blocked ? '安装未开始或结果未确认' : partial ? '部分 Skills 未确认' : '通用 Skills 安装结果'}>
      {portableSkillOffset > 0 ? <StaticRow title={`↑ 前面还有 ${portableSkillOffset} 个 Skills`} status="muted" compact /> : null}
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
    </Box> : <Box flexDirection="column"><ResultCard status={resultStatus} title={blockedDependencyFailure ? '依赖安装没有完成' : blocked ? result.writeMayHaveCompleted ? '结果未确认' : '操作未完成' : sourceOperation ? '来源配置写入已完成' : dependencyTargets ? partial ? '依赖安装没有全部完成' : '操作已完成' : resultSummary?.message ?? '状态已变化，请重新确认'}>{resetDispositionText ? <StaticRow title={resetDispositionText} status="success" compact /> : null}{resultTargetOffset > 0 ? <StaticRow title={`↑ 前面还有 ${resultTargetOffset} 个目标`} status="muted" compact /> : null}{visibleResultTargets.map((target) => { const state = operationTargetStateLabel(target.state); const relation = target.relation === 'requested' ? '你选择的插件' : target.relation === 'direct' ? '直接依赖' : target.relation === 'transitive' ? '间接依赖' : undefined; return <ResultRow key={`${target.pluginId ?? ''}:${target.platform}:${target.scope}`} title={resultTargetName(target)} description={relation} meta={state.label} status={state.status ?? 'muted'} compact={policy.mode === 'compact'} />; })}{hiddenResultTargets > 0 ? <StaticRow title="↓ 后面还有" meta={`${hiddenResultTargets} 个目标`} status="muted" compact /> : null}{partial && hasPreservedTarget && resultTargets.some((target) => target.state === 'skipped') ? <StaticRow title="未执行的目标没有写入；已完成或已保留的目标保持可用。" status="muted" compact /> : null}{configOperation && partial && !invalidConfigResult ? <Callout status="warning" title="恢复指引" description="如需清理残留，请返回插件详情选择清理；然后选择重新安装或同步。系统不会自动删除现有内容。" /> : null}{resultSummary?.elapsedMs !== undefined ? <StaticRow title="已用时" meta={`${Math.floor(resultSummary.elapsedMs / 1_000)}s`} /> : null}{visibleMessages.map((message, index) => <StaticRow key={`${index}:${message}`} title={productResultMessage(message)} status="muted" compact />)}</ResultCard><SemanticRows actions={actions} focus={focus} kind="action" compact offset={resultActionViewport.offset} limit={resultActionViewport.limit} /></Box>;
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
      detailRowBudget - 2 - plugin.installedPlacements.length - capabilityRowCount);
    const componentLimit = prioritizedComponents.length > componentRowBudget
      ? Math.max(1, componentRowBudget - 2)
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
      help = 'PgUp/PgDn 查看全部组件 · ↑↓ 移动 · Enter 选择 · Esc 返回';
    }
    content = <Box flexDirection="column"><TechnicalDetails><StaticRow title="canonical pluginId" meta={plugin.pluginId} /><StaticRow title="来源" meta={plugin.sourceId} />{plugin.capabilityUnsupported ? <><StaticRow title="failure code" meta="awCapabilityUnsupported" /><StaticRow title="capability 状态" meta="当前 AW CLI 不支持" status="error" /><StaticRow title="缺少 capability" meta={plugin.missingCapabilities?.join('、') ?? 'Status 未提供具体 capability'} /><StaticRow title="恢复方向" meta={plugin.capabilityRecovery ?? '升级 AW CLI 到支持所需 capability 的版本后重试。'} /></> : null}{plugin.installedPlacements.map((placement) => <StaticRow key={placement.platform} title={`${platformLabel(placement.platform)} target`} meta={placementStatus(placement).value} />)}{componentOffset > 0 ? <StaticRow title={`↑ 前面还有 ${componentOffset} 个组件`} status="muted" compact /> : null}{visibleComponents.map((component) => <StaticRow key={`${component.platform}:${component.scope}:${component.key}`} title={`组件 · ${component.state === 'absent' ? '缺失' : component.state}${component.errorCode ? ` · ${component.errorCode}` : ''} · ${component.key} · ${platformLabel(component.platform)} · ${scopeLabel(component.scope)}`} />)}{hiddenComponents > 0 ? <StaticRow title={`↓ 后面还有 ${hiddenComponents} 个组件`} status="muted" compact /> : null}</TechnicalDetails><SemanticRows actions={actions} focus={focus} kind="action" compact={policy.mode === 'compact'} /></Box>;
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
      case 'installTargets': case 'dependencyPlacement': case 'dependencyPlacementEditor':
      case 'pluginWriteTask': case 'pluginDetail': case 'pluginMore': case 'platform': case 'pluginAbout': case 'pluginTechnical':
      case 'configLayer':
        unavailable = missingPlugin ? 'plugin' : 'flow';
        break;
      case 'portableSkillSelect': case 'portableDependencies': case 'portableAgentMode':
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
      case 'catalogWorkspace':
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
    const remainingHelp = help.replace(' · ? 帮助', '').replace('? 帮助 · ', '');
    help = `${technicalHelp} · ? 帮助 · ${remainingHelp}`;
  } else if (canOpenHelp && !help.includes('? 帮助')) {
    help = `? 帮助 · ${help}`;
  }
  if (props.onSessionNavigation && !isCharacterInputMode(route, searchFocus)) {
    help = busy
      ? `h/H 完成后导航 · Esc 撤销等待 · ${help}`
      : `h 首页 · H 重载 · ${help}`;
  }

  const targetActionSignature = route.name === 'installTargets' && route.view !== 'blocked'
    ? actions.map((action) => String(Boolean(action.disabled))).join(',')
    : '';
  const batchSelectionActionSignature = route.name === 'batchSelection'
    && batchDraft?.stage === 'select'
    ? actions.map((action) => action.pluginId ?? action.label).join('\0')
    : '';

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
    setDraftUpdates({});
    setDraftRemoves([]);
    setObjectDrafts({});
    setChangedObjectDraftKeys([]);
    setObjectError(undefined);
    setSourceDraft(undefined);
    setBatchDraft(undefined);
    setCatalogInput('');
    setCatalogWorkspaceDraft({ ownerName: '', ownerUrl: '', displayName: '', catalogVersion: '0.1.0' });
    setCatalogPublishDraft({ targetKind: 'remote', target: '', branch: 'catalog' });
    setCatalogDevSourceId('');
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
        } else if (key.ctrl && input.toLowerCase() === 'c') {
          setExitAfterBusy(true);
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
          setDraftUpdates({});
          setDraftRemoves([]);
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
      requestExit({ code: snapshot.phase === 'error' ? 1 : 0, reason: snapshot.phase === 'error' ? 'initialError' : 'user' });
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
    if ((key.pageUp || key.pageDown)
      && route.name === 'review'
      && snapshot.activeReview) {
      const total = Math.max(
        snapshot.activeReview.changes.length,
        showTechnical ? snapshot.activeReview.technicalDetails?.length ?? 0 : 0,
      );
      const pageRows = 1;
      setBatchTargetOffset((value) => Math.min(
        Math.max(0, total - 1),
        Math.max(0, value + (key.pageUp ? -pageRows : pageRows)),
      ));
      return;
    }
    if ((key.pageUp || key.pageDown)
      && route.name === 'result'
      && snapshot.result) {
      const pageSummary = 'summary' in snapshot.result ? snapshot.result.summary : undefined;
      const total = pageSummary
        ? Math.max(
            pageSummary.targets?.length ?? 0,
            pageSummary.task?.rootResults.reduce((count, root) =>
              count + 1 + pageSummary.task!.requestedTargets.filter((target) =>
                target.pluginId === root.pluginId).length, 0) ?? 0,
            (pageSummary.batch?.rootResults.length ?? 0)
              + (pageSummary.targets?.length ?? 0),
            snapshot.result.operationKind === 'portableInstall'
              ? snapshot.portableResultSkills?.length ?? 0
              : 0,
          )
        : 0;
      const pageRows = 1;
      setBatchTargetOffset((value) => Math.min(
        Math.max(0, total - 1),
        Math.max(0, value + (key.pageUp ? -pageRows : pageRows)),
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
    if ((key.pageUp || key.pageDown) && route.name === 'sourceTechnical') {
      const overview = props.controller.getSourceOverview(route.sourceId);
      const diagnostic = sourceDiagnostic(
        route.sourceId,
        overview.health?.state ?? overview.source?.state,
        overview.detail,
        props.controller.getCatalogGeneration(route.sourceId),
        props.controller.getCatalogFreshness(route.sourceId),
      );
      const total = diagnostic ? diagnosticDetailRowCount(diagnostic) : 0;
      const pageRows = responsiveBudget(5, 10);
      setBatchTargetOffset((value) => Math.min(
        Math.max(0, total - pageRows),
        Math.max(0, value + (key.pageUp ? -pageRows : pageRows)),
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
    if ((key.pageUp || key.pageDown) && (route.name === 'catalogStore'
      || route.name === 'catalogPublish' && route.step === 'overview')) {
      const total = route.name === 'catalogStore'
        ? catalogStore?.entries.length ?? 0
        : catalogPublication?.records.length ?? 0;
      const pageRows = responsiveBudget(3, 7);
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
      && (key.pageUp || key.pageDown)) {
      const detail = route.name === 'operationDiagnostic'
        ? props.controller.getOperationDiagnostic(route.recordId) : undefined;
      const preview = route.name === 'operationReportPreview'
        ? props.controller.previewOperationReport(route.recordId) : undefined;
      const total = detail ? operationDiagnosticLineCount(detail)
        : preview ? operationReportLineCount(preview) : 0;
      const pageRows = policy.mode === 'compact' ? 2 : Math.max(1, pageActionBudget(5));
      setScrollOffset((value) => Math.min(
        Math.max(0, total - pageRows),
        Math.max(0, value + (key.pageUp ? -pageRows : pageRows)),
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
    if (route.name === 'catalogWorkspace' && (route.view === 'select'
      || route.view === 'create' || route.view === 'version' && route.step === 'catalogVersion')) {
      if (key.escape) {
        if (route.view === 'create') {
          const step = route.step ?? 'ownerName';
          const next = { ...catalogWorkspaceDraft, [step]: catalogInput };
          setCatalogWorkspaceDraft(next);
          const previous = ({ ownerUrl: 'ownerName', displayName: 'ownerUrl', catalogVersion: 'displayName' } as const)[step as 'ownerUrl' | 'displayName' | 'catalogVersion'];
          if (previous) {
            setCatalogInput(next[previous]);
            props.controller.replace({ ...route, step: previous });
          } else back();
        } else back();
        return;
      }
      if (key.return) {
        const value = catalogInput.trim();
        setCatalogInputError(undefined);
        if (route.view === 'select') {
          setCatalogLoading(true);
          void props.controller.selectCatalogWorkspace(value || undefined).then((workspace) => {
            setCatalogWorkspace(workspace);
            props.controller.replace({ name: 'catalogWorkspace', view: 'overview' });
            setFocus(0); setScrollOffset(0); setCatalogInput('');
          }).catch((error: unknown) => setCatalogInputError(sanitizeDiagnosticText(
            error instanceof Error ? error.message : String(error), [], [catalogInput],
          ))).finally(() => setCatalogLoading(false));
          return;
        }
        if (route.view === 'version') {
          if (!/^\d+\.\d+\.\d+(?:-beta\.\d+)?$/u.test(value)) {
            setCatalogInputError('版本必须是 x.y.z 或精确 x.y.z-beta.N。');
            return;
          }
          beginReview({ kind: 'catalogManagement', action: 'workspaceVersion', version: value }, { name: 'catalogWorkspace', view: 'overview' });
          return;
        }
        const step = route.step ?? 'ownerName';
        if (!value) { setCatalogInputError('此字段不能为空。'); return; }
        if (step === 'ownerUrl') {
          try {
            const url = new URL(value);
            if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error();
          } catch { setCatalogInputError('请输入有效的 HTTP 或 HTTPS owner URL。'); return; }
        }
        if (step === 'catalogVersion' && !/^\d+\.\d+\.\d+(?:-beta\.\d+)?$/u.test(value)) {
          setCatalogInputError('版本必须是 x.y.z 或精确 x.y.z-beta.N。');
          return;
        }
        const next = { ...catalogWorkspaceDraft, [step]: value };
        setCatalogWorkspaceDraft(next);
        setCatalogInput('');
        if (step === 'ownerName') props.controller.replace({ ...route, step: 'ownerUrl' });
        else if (step === 'ownerUrl') props.controller.replace({ ...route, step: 'displayName' });
        else if (step === 'displayName') { setCatalogInput('0.1.0'); props.controller.replace({ ...route, step: 'catalogVersion' }); }
        else beginReview({ kind: 'catalogManagement', action: 'workspaceInit', ...next }, { name: 'catalogWorkspace', view: 'overview' });
        return;
      }
      if (input === '\u0015' || (input.toLowerCase() === 'u' && key.ctrl)) setCatalogInput('');
      else if (key.backspace || key.delete) setCatalogInput(removeLastGrapheme);
      else if (input && !key.ctrl && !key.meta && input >= ' ') setCatalogInput((value) => value + input);
      setCatalogInputError(undefined);
      return;
    }
    if (route.name === 'catalogDev' && route.step && route.step !== 'overview') {
      if (key.escape) { back(); return; }
      if (key.return) {
        const value = catalogInput.trim();
        if (value && !CATALOG_SOURCE_ID_PATTERN.test(value)) {
          setCatalogInputError('格式必须是小写字母、数字或连字符，最多 32 字符。');
          return;
        }
        if (route.step === 'sourceId') {
          setCatalogDevSourceId(value);
          back();
        } else {
          if (!value) { setCatalogInputError('请输入替代主来源 ID。'); return; }
          beginReview({ kind: 'catalogManagement', action: 'devDeactivate', replacementPrimary: value }, { name: 'catalogDev' });
        }
        return;
      }
      if (input === '\u0015' || (input.toLowerCase() === 'u' && key.ctrl)) setCatalogInput('');
      else if (key.backspace || key.delete) setCatalogInput(removeLastGrapheme);
      else if (input && !key.ctrl && !key.meta && input >= ' ') setCatalogInput((value) => value + input);
      setCatalogInputError(undefined);
      return;
    }
    if (route.name === 'catalogPublish' && route.step !== 'overview') {
      if (key.escape) {
        if (route.step === 'branch') {
          setCatalogPublishDraft((draft) => ({ ...draft, branch: catalogInput.trim() || 'catalog' }));
          setCatalogInput(catalogPublishDraft.target);
          props.controller.replace({ name: 'catalogPublish', step: 'target' });
        } else {
          const value = catalogInput.trim();
          const targetKind = value.includes('://') || /^[^@\s]+@[^:\s]+:/u.test(value) || value.startsWith('/')
            ? 'remoteUrl' as const : 'remote' as const;
          setCatalogPublishDraft((draft) => ({ ...draft, targetKind, target: value }));
          back();
        }
        return;
      }
      if (key.return) {
        const value = catalogInput.trim();
        if (route.step === 'target') {
          if (/\s/u.test(value)) { setCatalogInputError('remote 名称或 URL 不能包含空白。'); return; }
          const targetKind = value.includes('://') || /^[^@\s]+@[^:\s]+:/u.test(value) || value.startsWith('/')
            ? 'remoteUrl' as const : 'remote' as const;
          setCatalogPublishDraft((draft) => ({ ...draft, targetKind, target: value }));
          setCatalogInput(catalogPublishDraft.expectedPlanDigest ? catalogPublishDraft.branch : 'catalog');
          props.controller.replace({ name: 'catalogPublish', step: 'branch' });
        } else {
          const branch = value || 'catalog';
          if (/\s|\.\.|[~^:?*\[\\]/u.test(branch) || branch.startsWith('-') || branch.endsWith('/')) {
            setCatalogInputError('请输入安全的 Git branch 名称。');
            return;
          }
          const draft = { ...catalogPublishDraft, branch };
          setCatalogPublishDraft(draft);
          const target = draft.target
            ? draft.targetKind === 'remote' ? { remote: draft.target } : { remoteUrl: draft.target }
            : {};
          beginReview(draft.expectedPlanDigest
            ? { kind: 'catalogManagement', action: 'publishApply', expectedPlanDigest: draft.expectedPlanDigest,
                ...target, branch }
            : { kind: 'catalogManagement', action: 'publishPlan', ...target, branch },
          { name: 'catalogPublish', step: 'overview' });
        }
        return;
      }
      if (input === '\u0015' || (input.toLowerCase() === 'u' && key.ctrl)) setCatalogInput('');
      else if (key.backspace || key.delete) setCatalogInput(removeLastGrapheme);
      else if (input && !key.ctrl && !key.meta && input >= ' ') setCatalogInput((value) => value + input);
      setCatalogInputError(undefined);
      return;
    }
    if (route.name === 'configFieldEditor'
      && (route.editor === 'string' || route.editor === 'number')
      && ((activeField?.choices?.length ?? 0) === 0 || route.mode === 'custom')) {
      if (key.escape) {
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
        back();
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
          setInputError('additionalProperty · 此对象不允许动态键。');
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
          else if (row) go(route.mode === 'browse'
              ? { name: 'pluginPreview', pluginId: row.pluginId }
              : { name: 'pluginDetail', pluginId: row.pluginId });
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
        if (input === '\u0015' || (input.toLowerCase() === 'u' && key.ctrl)) setQuery('');
        else if (key.backspace || key.delete) setQuery(removeLastGrapheme);
        else if (input && !key.ctrl && !key.meta && input >= ' ') setQuery((value) => value + input);
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
      setFocus(route.name === 'batchSelection' ? 1 : 0);
      setScrollOffset(0);
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
      const projection = buildDependencyGraphProjection({
        overviews: props.controller.listPluginDependencyOverviews(),
        rootPluginId: route.pluginId,
        direction: route.direction ?? 'dependencies',
        ...(expandedDependencyPluginIds ? { expandedPluginIds: expandedDependencyPluginIds } : {}),
      });
      const row = projection.rows[focus];
      if (!row) return;
      const next = new Set(expandedDependencyPluginIds ?? projection.defaultExpandedPluginIds);
      if (key.rightArrow && row.canExpand) next.add(row.pluginId);
      if (key.leftArrow && row.canExpand) next.delete(row.pluginId);
      const nextProjection = buildDependencyGraphProjection({
        overviews: props.controller.listPluginDependencyOverviews(),
        rootPluginId: route.pluginId,
        direction: route.direction ?? 'dependencies',
        expandedPluginIds: next,
      });
      const nextFocus = Math.max(0, nextProjection.rows.findIndex((candidate) => candidate.id === row.id));
      const nextScroll = Math.min(scrollOffset, nextFocus);
      setExpandedDependencyPluginIds(next);
      setFocus(nextFocus);
      setScrollOffset(nextScroll);
      persistDependencyGraphContext(route, nextProjection, next, nextFocus, nextScroll);
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
      setOverlayFocus(0);
      setDiscardForExit(dirty);
      setOverlay(dirty ? 'discard' : 'exit');
    } else if (input.toLowerCase() === 'd' && supportsTechnicalDetails) {
      toggleTechnical();
    } else if (globalAction === 'back'
      && (route.name === 'configFieldEditor'
        || route.name === 'configObjectPropertyEditor'
        || route.name === 'configFieldAction')) {
      back();
    } else if (globalAction === 'back' && route.name === 'batchPlacement') {
      back();
    } else if (globalAction === 'back'
      && (route.name === 'operationHistory'
        || route.name === 'operationDiagnostic'
        || route.name === 'operationReportPreview')) {
      back();
    } else if (globalAction === 'back') {
      if (dirty && route.name !== 'review'
        && !(batchDraft && (route.name === 'pluginPreview' || route.name === 'pluginDetail'))) {
        setOverlayFocus(0);
        setDiscardForExit(false);
        setOverlay('discard');
      } else back();
    } else if (route.name === 'pluginList' && input === '/') {
      setSearchFocus(true);
    } else if (route.name === 'pluginList' && input.toLowerCase() === 'f') {
      const selectedPluginId = pluginRows[focus]?.pluginId;
      const nextFilter = installFilter === 'all'
        ? route.mode === 'browse' ? 'uninstalled' : 'updateAvailable'
        : 'all';
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
      setFocus(retained >= 0 ? pluginListMenuCount(route.mode, nextItems) + retained : 0);
      setScrollOffset(0);
    } else if (route.name === 'pluginList' && input.toLowerCase() === 'm') {
      openBatchSelection(route.mode === 'browse' ? 'install' : undefined);
    } else if (route.name === 'pluginList' && route.mode === 'installed' && input.toLowerCase() === 'a') {
      prepareCurrentProjectPlugins();
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
    } else if (route.name === 'batchSelection' && batchDraft?.stage === 'select' && input.toLowerCase() === 'c') {
      if (batchDraft.selectedPluginIds.length > 0) {
        const invalid = invalidBatchSelection(batchDraft);
        if (invalid.length > 0) {
          setActionError(`${invalid.length} 个已选插件已不可用。请先在“查看全部已选”中取消选择。`);
          return;
        }
        if (batchDraft.mode === 'browse') {
          setBatchDraft((current) => current ? { ...current, action: 'install' } : current);
          props.controller.push({ name: 'batchPlacement' });
        } else setBatchDraft((current) => current ? { ...current, stage: 'task' } : current);
        setFocus(0);
        setScrollOffset(0);
      } else setActionError('请至少选择一个插件。');
    } else if (route.name === 'batchSelection' && batchDraft?.stage === 'select' && input === ' ') {
      const action = actions[normalizedEffectiveFocus];
      if (action?.pluginId
        && (batchDraft.selectedPluginIds.includes(action.pluginId) || action.canSelectNew)) {
        toggleBatchPlugin(action.pluginId);
      }
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
      setFocus(1);
      setScrollOffset(0);
    } else if (route.name === 'configFields' && route.layer.scope !== 'effective' && input.toLowerCase() === 's') {
      if (dirty && configDraftIssues.length === 0) {
        setFocus(0);
        go({ name: 'configSave', pluginId: route.pluginId, layer: { scope: route.layer.scope as Scope } });
      }
    } else if (route.name === 'configFields' && route.layer.scope !== 'effective' && input.toLowerCase() === 'u') {
      const key = actions[focus]?.configKey;
      const field = currentConfigPage?.groups.flatMap((group) => group.fields)
        .find((candidate) => candidate.key === key);
      if (field && configFieldCanUnset(field) && (!field.invalidOverrideIssue || field.invalidOverrideOwnedByLayer)) {
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
    } else if (input.toLowerCase() === 'r' && route.name === 'sourceDetail') {
      void props.controller.recheckCatalogSource(route.sourceId);
    } else if (input.toLowerCase() === 'r' && route.name === 'sourceList') {
      void props.controller.recheckAllCatalogSources();
    } else if (route.name === 'pluginList' && (key.leftArrow || key.rightArrow || input === '[' || input === ']')) {
      const tabs = ['all', ...props.controller.listSources().map((source) => source.id)];
      const current = route.sourceId ?? 'all';
      const selectedPluginId = pluginRows[focus]?.pluginId.startsWith('@menu:')
        ? undefined : pluginRows[focus]?.pluginId;
      const direction = key.leftArrow || input === '[' ? -1 : 1;
      const index = tabs.indexOf(current);
      const next = tabs[(index + direction + tabs.length) % tabs.length]!;
      const nextItems = props.controller.listPlugins({ mode: route.mode, ...(next !== 'all' ? { sourceId: next } : {}), ...(query ? { query } : {}), installFilter });
      const retained = selectedPluginId ? nextItems.findIndex((item) => item.pluginId === selectedPluginId) : -1;
      props.controller.replace(
        { name: 'pluginList', mode: route.mode, ...(next !== 'all' ? { sourceId: next } : {}) },
        { ...snapshot.router.current.context, query, installFilter, sourceTabId: next },
      );
      const retainedFocus = retained >= 0 ? pluginListMenuCount(route.mode, nextItems) + retained : 0;
      setFocus(retainedFocus);
      setScrollOffset(retainedFocus >= 4 ? retainedFocus - 3 : 0);
    } else if (input.toLowerCase() === 'a' && route.name === 'portableSkillSelect') {
      props.controller.selectAllPortableSkills();
    } else if (input === ' ' && route.name === 'portableSkillSelect') {
      const candidate = snapshot.portableDraft?.candidates[focus];
      if (candidate) props.controller.togglePortableSkill(candidate.name);
    } else if (key.upArrow || input.toLowerCase() === 'k') {
      setFocus((value) => {
        const current = route.name === 'batchSelection' && batchDraft?.stage === 'select'
          ? normalizedEffectiveFocus : dynamicActionIds ? effectiveFocus : value;
        const next = pluginRows.length > 0 ? moveIndex(pluginRows.length, current, -1) : moveFocus(actions, current, -1);
        if (dynamicActionIds && dynamicActionSignature !== undefined) {
          dynamicMenuFocus.current = {
            routeKey,
            actionIds: dynamicActionSignature,
            focusedActionId: dynamicActionIds[next],
          };
        }
        const viewport = route.name === 'batchSelection' && batchDraft?.stage === 'select'
          ? actionViewport(
              actions.slice(1),
              policy.mode === 'compact',
              Math.max(0, next - 1),
              Math.max(0, scrollOffset - 1),
              Math.max(1, pageActionBudget(5)),
            )
          : route.name === 'portableSkillSelect' && snapshot.portableDraft
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
              pageActionBudget(actionViewportStaticRows),
            );
        if (route.name === 'pluginDependencies' && route.view !== 'removeBlocked') {
          const projection = buildDependencyGraphProjection({
            overviews: props.controller.listPluginDependencyOverviews(),
            rootPluginId: route.pluginId,
            direction: route.direction ?? 'dependencies',
            ...(expandedDependencyPluginIds ? { expandedPluginIds: expandedDependencyPluginIds } : {}),
          });
          persistDependencyGraphContext(
            route,
            projection,
            expandedDependencyPluginIds ?? new Set(projection.defaultExpandedPluginIds),
            next,
            viewport.offset,
          );
        }
        setScrollOffset(route.name === 'batchSelection' && batchDraft?.stage === 'select'
          ? next === 0 ? 0 : viewport.offset + 1
          : viewport.offset);
        return next;
      });
    } else if (key.downArrow || input.toLowerCase() === 'j') {
      setFocus((value) => {
        const current = route.name === 'batchSelection' && batchDraft?.stage === 'select'
          ? normalizedEffectiveFocus : dynamicActionIds ? effectiveFocus : value;
        const next = pluginRows.length > 0 ? moveIndex(pluginRows.length, current, 1) : moveFocus(actions, current, 1);
        if (dynamicActionIds && dynamicActionSignature !== undefined) {
          dynamicMenuFocus.current = {
            routeKey,
            actionIds: dynamicActionSignature,
            focusedActionId: dynamicActionIds[next],
          };
        }
        const viewport = route.name === 'batchSelection' && batchDraft?.stage === 'select'
          ? actionViewport(
              actions.slice(1),
              policy.mode === 'compact',
              Math.max(0, next - 1),
              Math.max(0, scrollOffset - 1),
              Math.max(1, pageActionBudget(5)),
            )
          : route.name === 'portableSkillSelect' && snapshot.portableDraft
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
              pageActionBudget(actionViewportStaticRows),
            );
        if (route.name === 'pluginDependencies' && route.view !== 'removeBlocked') {
          const projection = buildDependencyGraphProjection({
            overviews: props.controller.listPluginDependencyOverviews(),
            rootPluginId: route.pluginId,
            direction: route.direction ?? 'dependencies',
            ...(expandedDependencyPluginIds ? { expandedPluginIds: expandedDependencyPluginIds } : {}),
          });
          persistDependencyGraphContext(
            route,
            projection,
            expandedDependencyPluginIds ?? new Set(projection.defaultExpandedPluginIds),
            next,
            viewport.offset,
          );
        }
        setScrollOffset(route.name === 'batchSelection' && batchDraft?.stage === 'select'
          ? next === 0 ? 0 : viewport.offset + 1
          : viewport.offset);
        return next;
      });
    } else if (key.return && route.name === 'pluginList' && pluginRows[focus]) {
      const row = pluginRows[focus]!;
      if (row.menuAction) row.menuAction();
      else go(route.mode === 'browse'
        ? { name: 'pluginPreview', pluginId: row.pluginId }
        : { name: 'pluginDetail', pluginId: row.pluginId });
    } else if (key.return) {
      runAction(actions[normalizedEffectiveFocus]);
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
      <Box position="absolute" marginTop={5} marginLeft={Math.max(2, Math.floor(size.columns / 5))} width={Math.max(40, Math.floor(size.columns * 0.6))} flexDirection="column">
        <ReviewCard title={overlay === 'help' ? '当前页快捷键'
          : overlay === 'discard' || overlay === 'sessionNavigation' ? '放弃未保存修改？'
          : '退出控制台？'}>
        {overlay === 'help'
          ? <>{helpRows.map(([key, value]) => <StaticRow key={key} title={`${key}  ${value}`} compact />)}</>
          : <StaticRow title={overlay === 'discard' ? '放弃后将返回上一页。'
            : overlay === 'sessionNavigation'
              ? `放弃后将${discardForSessionNavigation === 'reload' ? '重新读取本地状态' : '返回首页'}。`
              : '进行中的写操作会先完成。'} status="muted" />}
        <SemanticRows actions={overlayActions} focus={overlayFocus} kind="action" compact />
        </ReviewCard>
      </Box>
    </Box>
  );
}
