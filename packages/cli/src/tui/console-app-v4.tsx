import { arrayDraftChanged, arrayDraftValue, createConfigArrayDraft, editConfigArrayDraft, type ConfigArrayDraft, type ConfigArrayEdit } from './config-array-draft.js';
import { PLUGIN_CONFIG_ARRAY_MAX_ITEMS } from '@lesliechan721/aw-plugin-core';
import { presentConfigValue, safeConfigText } from './config-value-presentation.js';
import { Box, Text, useInput, useWindowSize } from 'ink';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
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
  ConfigTile,
  type ConfigTileProps,
  configTileHeight,
  HomeNavTile,
  KeyCap,
  ObjectCardFrame,
  ObjectCardRow,
  objectCardRowLayout,
  pluginListRowLayout,
  StatusBadge,
  diagnosticDetailLines,
  diagnosticDetailText,
  Callout,
  ChoiceRow,
  ContentViewport,
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
  operationDiagnosticText,
  operationHistoryMeta,
  operationHistoryState,
} from './operation-diagnostic-screens.js';
import { copyToClipboard } from './clipboard.js';
import { resolveTuiSizePolicy } from './layout.js';
import {
  buildDependencyGraphProjection,
  buildUnifiedDependencyGraphProjection,
  type DependencyGraphRow,
} from './dependency-graph.js';
import { DependencyGraphView, projectDependencyGraphView } from './dependency-graph-view.js';
import { platformLabel, scopeLabel } from './glossary.js';
import { InputDisplay, removeLastGrapheme } from './input-display.js';
import { QueryHeader, querySearchWidth } from './query-header.js';
import { Pager, Reader, paginateWrappedRows, readerPage } from './reader.js';
import { PluginDetailCard, ProjectRootCard, EntityPlacementRow, entityPlacementRowHeight,
  entityCardWindowHeight, pluginDetailCardLayout, projectRootCardLayout } from './entity-cards.js';
import { ContentItemCard, contentItemCardLayout, contentItemCardWindowHeight, contentItemHasReader,
  contentTypeLabels } from './content-item-card.js';
import { SourceDetailCard, sourceDetailCardLayout, type SourceDetailFacts } from './source-detail-card.js';
import { catalogRefPolicyForPreset } from './source-ref-presets.js';
import type {
  ConfigEditEvidence,
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
  configObjectHasSensitiveChild,
  hasInstalledPlacement,
  configValuesEqual,
} from './model.js';
import type { ProjectInventoryRoot } from './project-inventory.js';
import type { ProjectTuiPlan } from './project-flow.js';
import type { ProjectAgentId } from '../project/project-preferences.js';
import type { ProjectRecoveryReceiptV1 } from '../project/project-types.js';
import type { PluginContentItem, PluginContentType } from './plugin-content.js';
import type { PluginInstallFilter, TuiRoute } from './router.js';
import { resolveTuiGlobalKeyAction, resolveTuiSessionNavigationKey } from './keys.js';
import { tuiTheme } from './theme.js';
import { contentRowBudget, rowViewport, wrapDisplayText, type RowViewport } from './viewport.js';
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

interface SplitTaskContext {
  goal: PluginWriteTaskGoal;
  targets: Extract<OperationIntent, { kind: 'pluginWriteTask' }>['targets'];
  executionPolicy: 'all' | 'executableSubset';
  currentScope: Scope;
  returnRoute: TuiRoute;
}

function splitTaskLines(context: SplitTaskContext): string[] {
  const targetLabel = (target: SplitTaskContext['targets'][number]): string =>
    `${target.pluginId} · ${platformLabel(target.platform)} · ${scopeLabel(target.scope)}`;
  return [
    `完整任务请求：${context.targets.length} 个位置`,
    ...context.targets.map((target) => `请求：${targetLabel(target)}`),
    `本次范围：${scopeLabel(context.currentScope)}`,
    ...context.targets.filter((target) => target.scope !== context.currentScope)
      .map((target) => `其余范围未处理：${targetLabel(target)}`),
  ];
}

type ProjectUiFlow =
  | { stage: 'targets'; agents: ProjectAgentId[]; focus: number }
  | { stage: 'preparing'; request: 'recovery' | 'targets'; returnTo: 'project' | 'targets' | 'task'; task?: SplitTaskContext }
  | { stage: 'review'; plan: ProjectTuiPlan; returnTo: 'project' | 'targets' | 'task'; task?: SplitTaskContext; focus: number }
  | { stage: 'progress'; plan: ProjectTuiPlan; task?: SplitTaskContext }
  | { stage: 'result'; plan?: ProjectTuiPlan; receipt?: ProjectRecoveryReceiptV1;
      changed?: boolean; errorCode?: string; task?: SplitTaskContext; focus: number };

function projectPlanText(plan: ProjectTuiPlan, task?: SplitTaskContext): string {
  if (plan.kind === 'targets') return [
    '本次只保存本机偏好；不安装、删除或切换旧 Agent 输出。',
    ...plan.changes, ...plan.warnings,
  ].join('\n');
  const { receipt } = plan.plan;
  return [
    ...(task ? splitTaskLines(task) : []),
    ...(receipt.command === 'cleanup' && plan.plan.removedPluginIds?.length ? [
      '整体清理会取消目标插件在个人及当前项目中的需求和设置，并移除可证明归属的共用原生安装。其他项目可能失去该共用包。',
      '不能安全删除的 Portable 或其他输出会列为未完成，不会当作已清理。',
    ] : receipt.command === 'cleanup' ? [
      '普通清理仅处理所选目标的可验证现场，保留项目需求及共享设置。',
    ] : []),
    `项目全部需求：${receipt.intent.roots?.join('、') || '空项目或无法读取'}`,
    `本次请求：${receipt.requestedRoots.join('、') || '空项目'}`,
    `所选 Agent：${receipt.selection.agents.join('、') || '未选择'}（${receipt.selection.origin}）`,
    `可执行目标：${receipt.targetResults.filter((target) => target.blockers.length === 0).length} 项`,
    `受阻或未完成：${receipt.targetResults.filter((target) => target.blockers.length > 0).length} 项`,
    ...receipt.targetResults.map((target) => {
      const delivery = target.delivery?.kind === 'native'
        ? `Native ${target.delivery.platform}`
        : target.delivery?.kind === 'agent-skills' ? '通用 Skills' : '无适用交付';
      return `${target.pluginId} · ${target.agent} · ${delivery} · ${target.blockers.length > 0
        ? target.blockers.map((blocker) => blocker.code).join('、') : target.observation}`;
    }),
    ...receipt.blockers.map((blocker) => `阻断：${blocker.code} · ${blocker.message}`),
    ...receipt.targetResults.flatMap((target) =>
      (target.recoveryActions ?? []).map((action) => `恢复：${action}`)),
    ...plan.plan.changes.map((change) => `影响：${change}`),
    ...plan.plan.warnings.map((warning) => `注意：${warning}`),
  ].join('\n');
}

function projectResultText(receipt: ProjectRecoveryReceiptV1, task?: SplitTaskContext): string {
  return [
    ...(task ? splitTaskLines(task) : []),
    `请求：${receipt.requestedRoots.join('、') || '空项目'}`,
    ...receipt.targetResults.map((target) =>
      `${target.pluginId} · ${target.agent} · ${target.execution} · ${target.observation}`),
    ...receipt.remainingTargets.map((target) => `未完成：${target.pluginId} · ${target.agent}`),
    ...receipt.recoveryActions.map((action) => `恢复：${action}`),
  ].join('\n');
}

function projectAgentsForPlatform(platform: PlatformName | 'both'): ProjectAgentId[] {
  return platform === 'both' ? ['codex', 'claude-code']
    : [platform === 'claude' ? 'claude-code' : 'codex'];
}

const PLUGIN_FILTERS: PluginInstallFilter[] = [
  'all', 'installed', 'uninstalled', 'updateAvailable', 'attention', 'project', 'user',
];

type ProjectStatusFilter = 'all' | 'pending' | 'blocked' | 'unknown' | 'ready';
const PROJECT_STATUS_FILTERS: ProjectStatusFilter[] = ['all', 'pending', 'blocked', 'unknown', 'ready'];
const PROJECT_STATUS_LABELS: Record<ProjectStatusFilter, string> = {
  all: '全部', pending: '待同步', blocked: '受阻', unknown: '未确认', ready: '就绪',
};

function queryMatches(query: string, ...values: Array<string | null | undefined>): boolean {
  const normalized = query.trim().toLocaleLowerCase();
  return !normalized || values.some((value) => value?.toLocaleLowerCase().includes(normalized));
}

function contentMatches(query: string, item: PluginContentItem): boolean {
  return queryMatches(query, item.name,
    item.descriptionState === 'issue' ? undefined : item.description);
}

function pluginFilterLabel(filter: PluginInstallFilter): string {
  return {
    all: '全部',
    installed: '已安装',
    uninstalled: '未安装',
    updateAvailable: '可更新',
    attention: '需处理',
    project: '当前项目',
    user: '所有项目',
  }[filter];
}

interface ActionItem {
  role?: 'navigation';
  actionId?: string;
  label: string;
  description?: string;
  meta?: string;
  status?: 'success' | 'warning' | 'error' | 'info' | 'muted';
  disabled?: string;
  run?: () => void | Promise<void>;
  configKey?: string;
  configTile?: Omit<ConfigTileProps, 'width' | 'title' | 'focused' | 'bodyRows' | 'page'>;
  exception?: string;
  selected?: boolean;
  pluginId?: string;
  canSelectNew?: boolean;
  tags?: ReactNode;
  sourceLabel?: string;
  maxDescriptionRows?: number;
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
  editEvidence?: Record<string, ConfigEditEvidence>;
  updates: Record<string, PluginConfigValue>;
  removes: string[];
}

interface ConfigCandidate {
  editEvidence?: ConfigEditEvidence;
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
  return 'scope' in action && 'platform' in action
    ? `${action.id}:${action.platform}:${action.scope}`
    : action.id === 'platform' || action.id === 'scopeConflict'
    ? `${action.id}:${action.platform}`
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

interface BatchSelectionCandidate {
  pluginId: string;
  plugin?: PluginListItemViewModel;
}

interface DependencyGraphSessionContext {
  expandedPluginIds: Set<string>;
  focusedRowId?: string;
  scrollAnchorRowId?: string;
}

function isCharacterInputMode(route: TuiRoute, searchMode: boolean): boolean {
  if (searchMode) return true;
  if (routeDefinition(route).keymap !== 'menuOrTextInput') return false;
  return route.name === 'portableAgentInput'
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

function helpTextForPage(help: string, busy: boolean): string {
  return [...help.split(' · ').filter((part) => part !== '? 帮助' && !/^(q|Ctrl-C) /u.test(part)),
    `q / Ctrl-C ${busy ? '操作完成后退出' : '退出控制台'}`,
    ...(!busy ? ['o 查看操作记录'] : []), 'Esc / ? 关闭帮助'].join('\n');
}

function projectDependencyLines(root: ProjectInventoryRoot | undefined): string[] {
  return root?.dependencies.flatMap((dependency) => dependency.targets.map((target) =>
    `依赖 ${dependency.displayName} · ${dependency.pluginId} · ${platformLabel(target.platform)} · ${target.location === 'sharedUser' ? '共用个人安装' : '当前项目'} · 目录参考 ${target.expectedVersion ?? '未知'} · 实际 ${target.installedVersion ?? '未知'}${target.reasonCodes.length ? ` · ${target.reasonCodes.map((code) => safeDiagnosticCode(code, 'projectTargetUnknown')).join('、')}` : ''}`)) ?? [];
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
  direction: 'dependencies' | 'dependents' | 'portable',
): string {
  return `${pluginId}\0${direction}`;
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

function pluginPlatformUnknown(plugin: PluginListItemViewModel, platform: PlatformName): boolean {
  const placements = plugin.installedPlacements.filter((entry) => entry.platform === platform);
  return plugin.sourceUnavailable || placements.length === 0
    || placements.some((entry) => entry.state === 'installed' && entry.sharedNative?.state === 'unobserved');
}

function pluginPlatformBadges(plugin: PluginListItemViewModel): React.JSX.Element {
  const items = plugin.supportedPlatforms.map((platform) => {
    const placements = plugin.installedPlacements.filter((entry) => entry.platform === platform);
    const installed = placements.some((entry) => entry.state === 'installed' || entry.state === 'scopeConflict');
    const unknown = pluginPlatformUnknown(plugin, platform);
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
    if (!actions[next]?.disabled && actions[next]?.role !== 'navigation') return next;
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
  return wrapDisplayText(value, columns);
}

function sourceRefSummary(value: string | undefined): string {
  if (!value) return '未知';
  if (/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/iu.test(value)) return value.slice(0, 8);
  return value.replace(/^refs\/(?:heads|tags)\//u, '');
}

function relativeCheckTime(value: string | undefined, now = Date.now()): string {
  if (!value) return '尚未检查';
  const checkedAt = Date.parse(value);
  if (!Number.isFinite(checkedAt)) return '时间未知';
  const elapsed = Math.max(0, now - checkedAt);
  if (elapsed < 60_000) return '刚刚';
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟前`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} 小时前`;
  return `${Math.floor(elapsed / 86_400_000)} 天前`;
}

function parseConfigNumberInput(input: string): number | undefined {
  return input.trim().length === 0 ? undefined : Number(input);
}

function changeDetailText(
  changes: ReadonlyArray<{ title: string; before?: string; after?: string; children?: Array<{ property: string; before: string; after: string }> }>,
): string {
  return changes.flatMap((change) => [
    `修改项 · ${change.title}`,
    `修改前\n  ${change.before ?? '未设置'}`,
    `修改后\n  ${change.after ?? '未设置'}`,
    ...(change.children ?? []).flatMap((child) => [
      child.property, `修改前\n  ${child.before}`, `修改后\n  ${child.after}`,
    ]),
  ]).join('\n');
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
    rowHeights: actions.map((action) => action.role === 'navigation' ? 0 : compact || (!action.description && !action.disabled) ? 1 : 2),
    focus,
    requestedOffset,
    rowBudget: lineBudget,
  });
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

function matchingSources(
  controller: TuiController,
  query: string,
  type: 'all' | 'git' | 'path',
): ReturnType<TuiController['listSources']> {
  return controller.listSources().filter((source) => {
    const configured = controller.getConfiguredSource(source.id);
    const detail = controller.getSourceOverview(source.id).detail;
    const sourceType = configured?.type ?? detail?.type;
    return (type === 'all' || sourceType === type)
      && queryMatches(query, source.id, detail?.locationSummary,
        configured?.type === 'git' ? configured.url : configured?.path);
  });
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
  if (generation?.errorCode === 'catalogLogicalIdentityChanged') {
    return {
      severity: 'error',
      title: '来源发布身份已变化',
      userMessage: '待检查内容与当前来源不是同一发布身份。当前状态不能据此判定为健康。',
      impact: [
        { state: 'blocked', message: '不能把待检查内容作为当前来源的更新。' },
        { state: 'degraded', message: '旧 Active 是否仍可用需要单独验证。' },
      ],
      nextStep: '检查来源地址和发布身份，然后编辑来源，或移除后重新添加。',
      technical: {
        code: 'catalogLogicalIdentityChanged',
        stage: 'compare-source-identity',
        sourceId,
        checks: ['核对来源地址、ref 和 logical identity。', '确认后编辑来源，或移除后重新添加。'],
      },
    };
  }
  if (generation?.compatibility?.state === 'unsupported') {
    const { requiredCapabilities, missingCapabilities } = generation.compatibility;
    const missingKnown = missingCapabilities.length > 0;
    return {
      severity: 'error',
      title: '当前目录版本不兼容',
      userMessage: missingKnown
        ? `当前 AW 缺少 ${missingCapabilities.length} 项所需功能支持。`
        : '当前目录版本所需功能无法确认。',
      impact: [
        { state: 'blocked', message: '这个目录版本不能用于浏览、安装或同步。' },
        { state: 'preserved', message: '当前启用版本和已下载内容保持不变。' },
      ],
      nextStep: missingKnown
        ? '升级 AW 到支持所需能力的版本，或修改来源后重新启用。'
        : '检查来源内容和 capability 诊断，再决定修复来源或更新 AW。',
      technical: {
        code: 'awCapabilityUnsupported',
        stage: 'resolve-source',
        sourceId,
        context: [{
          key: 'compatibility',
          value: `required: ${requiredCapabilities.join('、')}; missing: ${missingCapabilities.join('、')}`,
        }],
        checks: missingKnown
          ? ['检查所需和缺少的 Catalog capability。', '升级 AW 后重新加载来源。']
          : ['检查来源的 capability 声明和验证错误。', '确认原因后重新加载来源。'],
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
    const activeHealthy = generation?.state === 'ready' && generation.active !== undefined;
    const missingCount = freshness.missingCapabilities?.length ?? 0;
    const missingSummary = missingCount && missingCount > 0
      ? `缺少 ${missingCount} 项待检查版本所需功能`
      : '待检查版本所需功能无法确认';
    return {
      severity: 'error',
      title: '待检查版本不兼容',
      userMessage: activeHealthy
        ? `当前 AW ${missingSummary}。普通更新已阻止；已验证的当前目录版本保持不变。`
        : `当前 AW ${missingSummary}。这个来源没有已验证可用的目录版本。`,
      impact: [
        { state: 'blocked', message: '不能直接切换到这个待检查版本。' },
        ...(activeHealthy ? [{ state: 'preserved' as const, message: '已验证的当前目录版本和插件浏览仍可用。' }] : []),
      ],
      nextStep: missingCount > 0
        ? '升级 AW 到支持待检查版本所需功能的版本，或编辑来源后重新验证。'
        : '检查来源的 capability 声明和安全诊断，再决定修正来源或升级 AW。',
      technical: {
        code: safeDiagnosticCode(freshness.errorCode, 'catalogincompatible'),
        stage: 'compare-candidate',
        sourceId,
        ...(freshness.missingCapabilities?.length ? {
          context: [{ key: 'compatibility' as const, value: freshness.missingCapabilities.join('、') }],
        } : {}),
        checks: missingCount > 0
          ? ['检查缺少的 Catalog capability。', '升级 AW 后执行完整验证。']
          : ['检查来源的 capability 声明。', '查看安全错误代码后重新验证。'],
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
        if (action.role === 'navigation') return null;
        const index = visibleIndex + offset;
        // The legacy label suffix is display metadata, never an action or permission lookup.
        const keyHint = action.label.match(/ \[([a-z/?])\]$/u);
        const rowProps = {
          title: keyHint ? action.label.slice(0, -keyHint[0].length) : action.label,
          keyHint: keyHint?.[1],
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
          sourceLabel={action.sourceLabel} maxDescriptionRows={action.maxDescriptionRows}
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

function SequenceRows(props: {
  actions: ActionItem[];
  itemCount: number;
  focus: number;
  scrollOffset: number;
  columns: number;
  rowBudget: number;
  compact: boolean;
  cards?: boolean;
  inactive?: boolean;
  wrapValues?: boolean;
  skillRows?: boolean;
  configPage?: number;
}): React.JSX.Element {
  const configLines = (action: ActionItem): string[] => [
    ...wrapConsoleText(`${action.label}${action.meta ? ` · ${action.meta}` : ''}`, Math.max(1, props.columns - 2)),
    ...(action.description ? wrapConsoleText(action.description, Math.max(1, props.columns - 2)) : []),
  ];
  const viewport = rowViewport({
    rowHeights: props.actions.map((action, index) => action.role === 'navigation' ? 0 : index < props.itemCount
      ? action.configTile ? configTileHeight({ width: props.columns, ...action.configTile,
          focused: !props.inactive && index === props.focus, bodyRows: Math.max(1, props.rowBudget - 3) })
        : props.skillRows ? 2 + (action.exception ? 1 : 0)
        : props.wrapValues ? configLines(action).length : props.cards ? objectCardRowLayout({
          width: props.columns, description: action.disabled ?? action.description ?? '',
          meta: action.meta, sourceLabel: action.sourceLabel, maxDescriptionRows: action.maxDescriptionRows,
          hasTags: action.tags !== undefined, compact: props.compact,
        }).height : action.description ? 2 : 1
      : 1),
    focus: props.focus, requestedOffset: props.scrollOffset, rowBudget: props.rowBudget,
  });
  return <ContentViewport>
    {props.actions.slice(viewport.offset, viewport.offset + viewport.limit).map((action, visibleIndex) => {
      if (action.role === 'navigation') return null;
      const index = viewport.offset + visibleIndex;
      const focused = !props.inactive && index === props.focus;
      if (index < props.itemCount && action.configTile) return <ConfigTile key={action.configKey}
        width={props.columns} title={action.label} focused={focused} {...action.configTile}
        bodyRows={Math.max(1, props.rowBudget - 3)} page={focused ? props.configPage : 1} />;
      if (index < props.itemCount && props.skillRows) return <Box key={action.actionId ?? action.label}
        flexDirection="column" backgroundColor={focused ? tuiTheme.colors.selectionBackground : undefined}>
        <Text bold={focused} color={tuiTheme.roles.primaryValue} wrap="truncate-end">{focused ? '›' : ' '} [{action.selected ? 'x' : ' '}] {action.label}</Text>
        <Text color={tuiTheme.roles.secondary} wrap="truncate-end">    {action.description || '暂无简介'}</Text>
        {action.exception ? <Text color={tuiTheme.roles.warning} wrap="truncate-end">    ! {action.exception}</Text> : null}
      </Box>;
      if (index < props.itemCount && props.wrapValues) return <Box key={action.configKey ?? action.label} flexDirection="column">
        {configLines(action).map((line, lineIndex) => <Text key={lineIndex} bold={focused && lineIndex === 0}
          color={action.status === 'error' ? 'red' : undefined}>{lineIndex === 0 ? focused ? '› ' : '  ' : '  '}{line}</Text>)}
      </Box>;
      return index < props.itemCount && props.cards
        ? <ObjectCardRow key={action.actionId ?? action.pluginId ?? action.label}
            width={props.columns}
            title={`${action.selected === undefined ? '' : action.selected ? '[x] ' : '[ ] '}${action.label}`}
            description={action.disabled ?? action.description ?? ''} meta={action.meta}
            sourceLabel={action.sourceLabel} maxDescriptionRows={action.maxDescriptionRows}
            tags={action.tags} focused={focused} compact={props.compact} />
        : <SemanticRows key={action.actionId ?? action.label} actions={[action]}
            focus={focused ? 0 : -1} kind={index < props.itemCount ? 'section' : 'action'}
            compact={index >= props.itemCount} />;
    })}
  </ContentViewport>;
}

function PluginRows(props: {
  columns: number;
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
            width={props.columns}
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

function dependencyEvidenceLines(
  row: DependencyGraphRow,
  subject: ReturnType<TuiController['getPluginDetailSubject']>,
): string[] {
  const references = row.edge?.availablePlacementReferences ?? [];
  const placementLines = subject?.placements.map((placement) =>
    `安装位置 · ${platformLabel(placement.platform)} · ${scopeLabel(placement.scope)} · 实际安装版本 ${placement.installedVersion ?? '未确认'} · 观察 ${placement.observation === 'unknown' ? '未确认' : '已检查'}`) ?? [];
  const referenceLines = (reference: typeof references[number]): string[] => [
    `consumer · ${reference.consumer.pluginId}`,
    `consumer · platform=${platformLabel(reference.consumer.platform)} · scope=${reference.consumer.scope}`,
    `consumer · project=${reference.consumer.project ?? 'none'}`,
    `dependency · ${reference.dependency.pluginId}`,
    `dependency · platform=${platformLabel(reference.dependency.platform)} · scope=${reference.dependency.scope}`,
    `dependency · project=${reference.dependency.project ?? 'none'}`,
  ];
  const availablePath = row.relationship === 'directAvailable'
    || row.relationship === 'indirectAvailable';
  return [
    `pluginId · ${row.pluginId}`,
    `目录版本 · ${subject?.catalogVersion ?? '未确认'}`,
    ...(placementLines.length ? placementLines : ['安装位置 · 本次无位置事实']),
    `relationship · ${row.relationship}`,
    `图路径 · ${row.pathPluginIds.join(' → ')}`,
    `直接边声明 · ${row.edge?.declared ? '已声明' : '未确认'}`,
    `直接边已验证位置 · ${references.length} 个`,
    ...references.flatMap((reference, index) => [
      `直接边引用 ${index + 1}`,
      ...referenceLines(reference),
    ]),
    ...(availablePath && row.pathReferences.length
      ? row.pathReferences.flatMap((path, index) => [
        `连续已验证路径 ${index + 1} · ${path.length} 段`,
        ...path.flatMap((reference, hop) => [
          `连续路径 ${index + 1} · 第 ${hop + 1} 段`,
          ...referenceLines(reference),
        ]),
      ])
      : ['连续路径 · 未验证']),
  ];
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
  const unifiedProjectScope = Boolean(snapshot.projectInventory?.recovery
    || snapshot.projectInventory?.declarationState === 'absent'
      && snapshot.projectInventory.projectRoot);
  const [overlay, setOverlay] = useState<Overlay>();
  const [overlayFocus, setOverlayFocus] = useState(0);
  const [helpPage, setHelpPage] = useState(1);
  const [operationConfirmation, setOperationConfirmation] = useState<OperationConfirmationOverlay>();
  const [sourceTransportOverlay, setSourceTransportOverlay] = useState<SourceTransportOverlay>();
  const [projectReminderOpen, setProjectReminderOpen] = useState(false);
  const [projectFlow, setProjectFlow] = useState<ProjectUiFlow>();
  const [splitTaskReview, setSplitTaskReview] = useState<SplitTaskContext>();
  const projectFlowToken = useRef(0);
  const projectFlowEnterBusy = useRef(false);
  const projectPageAnchor = useRef(0);
  const [projectAgentsDraft, setProjectAgentsDraft] = useState<ProjectAgentId[]>([]);
  const [discardForExit, setDiscardForExit] = useState(false);
  const [discardForSessionNavigation, setDiscardForSessionNavigation] = useState<SessionNavigation>();
  const [discardDraftConfirmation, setDiscardDraftConfirmation] = useState<ExternalDraftState[]>();
  const [focus, setFocus] = useState(0);
  const [graphEvidenceOpen, setGraphEvidenceOpen] = useState(false);
  const [graphPortableSelectionOpen, setGraphPortableSelectionOpen] = useState(false);
  const actionJumpAnchor = useRef<{ routeKey: string; index: number; entityId?: string } | undefined>(undefined);
  const detailActionAnchor = useRef<{ routeKey: string; signature: string; actionId?: string } | undefined>(undefined);
  const [searchCursor, setSearchCursor] = useState(0);
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
  const [installPlatformIndex, setInstallPlatformIndex] = useState(0);
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
  const [arrayDrafts, setArrayDrafts] = useState<Record<string, ConfigArrayDraft & { evidence?: ConfigEditEvidence }>>({});
  const [arrayToolsOpen, setArrayToolsOpen] = useState(false);
  const [arrayToolFocus, setArrayToolFocus] = useState(0);
  const [objectDrafts, setObjectDrafts] = useState<Record<string, PluginConfigObject>>({});
  const [changedObjectDraftKeys, setChangedObjectDraftKeys] = useState<string[]>([]);
  const [objectError, setObjectError] = useState<string>();
  const [inputValue, setInputValue] = useState('');
  const [inputError, setInputError] = useState<string>();
  const [configActionError, setConfigActionError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [copyFeedback, setCopyFeedback] = useState<{ routeKey: string; message: string }>();
  const [configResetAvailability, setConfigResetAvailability] = useState<Partial<Record<
    Scope,
    Awaited<ReturnType<TuiController['getConfigResetAvailability']>>
  >>>({});
  const [sourceDraft, setSourceDraft] = useState<SourceDraft>();
  const [batchDraft, setBatchDraft] = useState<BatchDraft>();
  const batchSelectionAnchor = useRef<{
    frameId: string; pluginId: string; index: number; scrollOffset: number;
  } | undefined>(undefined);
  const [batchTargetOffset, setBatchTargetOffset] = useState(0);
  const [configCardPage, setConfigCardPage] = useState<{ key: string; page: number }>();
  const [contentReader, setContentReader] = useState<{
    pluginId: string; itemId?: string; returnLineOffset: number;
  }>();
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
  const listFocusAnchor = useRef<{ frameId: string; ids: string; entityId?: string } | undefined>(undefined);
  const dependencyGraphContexts = useRef(new Map<string, DependencyGraphSessionContext>());
  const externalDraftRevision = useRef({ config: 0, source: 0, batch: 0 });
  const previousExternalDraftValues = useRef({
    configDrafts, configCandidate, arrayDrafts, objectDrafts, changedObjectDraftKeys, sourceDraft, batchDraft,
  });
  const externalDraftFlowIds = useRef(new Map<string, string>());
  const configOverviewAnchors = useRef(new Map<string, { overviewFrameId: string; flowId?: string }>());
  const exitSent = useRef(false);
  const operationBusy = useRef(false);
  const route = snapshot.router.current.route;
  const platformFacts = route.name === 'platform'
    ? props.controller.getPluginDetailSubject(route.pluginId)?.placements
      .filter((entry) => entry.platform === route.platform) ?? []
    : [];
  const platformContext = snapshot.router.current.context;
  const platformSelectedScope = route.name === 'platform'
    && platformFacts.some((entry) => entry.scope === platformContext.platformSelectedScope)
    ? platformContext.platformSelectedScope : undefined;
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
  const detailSubject = route.name === 'pluginDetail'
    ? props.controller.getPluginDetailSubject(route.pluginId) : undefined;
  const issue = route.name === 'issueDetail'
    ? props.controller.listUserIssues().find((entry) => entry.issueId === route.issueId)
    : undefined;
  const busy = route.name === 'progress';
  const preparationRunning = route.name === 'reviewPreparing'
    && snapshot.reviewPreparation?.state === 'running';
  useEffect(() => {
    if (route.name !== 'pluginDependencyNode' || route.view === 'references') return;
    props.controller.replace({ name: 'pluginDetail', pluginId: route.nodePluginId });
  }, [props.controller, route.name,
    route.name === 'pluginDependencyNode' ? route.nodePluginId : '',
    route.name === 'pluginDependencyNode' ? route.view : '']);
  useEffect(() => {
    if (route.name !== 'platform') return;
    const selected = snapshot.router.current.context.platformSelectedScope;
    if (!snapshot.router.current.context.platformSelectionInitialized) {
      props.controller.updatePageContext({
        platformSelectionInitialized: true,
        platformSelectedScope: platformFacts.length === 1 ? platformFacts[0]!.scope : undefined,
      });
    } else if (selected && !platformFacts.some((entry) => entry.scope === selected)) {
      props.controller.updatePageContext({ platformSelectedScope: undefined });
      setActionError('已选位置不再存在；请重新选择位置。');
    }
  }, [props.controller, route.name, route.name === 'platform' ? route.pluginId : '',
    route.name === 'platform' ? route.platform : '', snapshot.viewModel,
    snapshot.router.current.context.platformSelectionInitialized,
    snapshot.router.current.context.platformSelectedScope,
    platformFacts.map((entry) => entry.scope).join('\0')]);
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
      || reminder.actionableTargets.length + reminder.blockedTargets.length
        + (reminder.kind === 'recovery'
          ? reminder.unconfirmedTargets.length + reminder.diagnosticCodes.length : 0) === 0
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
      && (!reminder || reminder.actionableTargets.length + reminder.blockedTargets.length
        + (reminder.kind === 'recovery'
          ? reminder.unconfirmedTargets.length + reminder.diagnosticCodes.length : 0) === 0)) {
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
        .filter(([draftScope]) => !savedScopes.has(draftScope as Scope))
        .map(([scope, draft]) => [scope, draft.editEvidence ? { ...draft, editEvidence: Object.fromEntries(
          Object.entries(draft.editEvidence).map(([key, evidence]) => [key, {
            ...evidence, storeDigests: Object.fromEntries(Object.entries(evidence.storeDigests)
              .filter(([savedScope]) => !savedScopes.has(savedScope as Scope))),
          }]),
        ) } : draft]));
      setConfigDrafts(nextDrafts);
      setDirty(Object.keys(nextDrafts).length > 0);
      setConfigCandidate(undefined);
      setObjectDrafts({});
      setArrayDrafts({});
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
      setArrayDrafts({});
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
      || previous.arrayDrafts !== arrayDrafts
      || previous.objectDrafts !== objectDrafts
      || previous.changedObjectDraftKeys !== changedObjectDraftKeys) {
      externalDraftRevision.current.config += 1;
    }
    if (previous.sourceDraft !== sourceDraft) externalDraftRevision.current.source += 1;
    if (previous.batchDraft !== batchDraft) externalDraftRevision.current.batch += 1;
    previousExternalDraftValues.current = {
      configDrafts, configCandidate, arrayDrafts, objectDrafts, changedObjectDraftKeys, sourceDraft, batchDraft,
    };
    const currentFlowId = snapshot.router.currentFlowId;
    if (currentFlowId && configRouteOwner) {
      externalDraftFlowIds.current.set(configRouteOwner, currentFlowId);
    }
    if (currentFlowId && sourceDraft) externalDraftFlowIds.current.set(sourceDraft.owner, currentFlowId);
    const drafts: ExternalDraftState[] = [];
    if ((dirty || configCandidate || Object.values(arrayDrafts).some((draft) =>
      draft.initial === undefined ? draft.rows.length > 0 : arrayDraftChanged(draft)) || changedObjectDraftKeys.length > 0) && draftOwner) {
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
    configDrafts, configCandidate, arrayDrafts, objectDrafts, route.name, snapshot.router.currentFlowId, sourceDraft,
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
        setArrayDrafts({});
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
    if (unifiedProjectScope
      && new Set(candidates.map((candidate) => candidate.target.scope)).size > 1) return;
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
    unifiedProjectScope,
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
    if (route.name !== 'pluginDependencies' && route.name !== 'portableDependencies') return;
    if (route.name === 'pluginDependencies' && route.view === 'removeBlocked') return;
    const key = dependencyGraphContextKey(route.pluginId,
      route.name === 'portableDependencies' ? 'portable' : 'dependencies');
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
    const layout = projectDependencyGraphView(projection, { columns: size.columns - 2,
      rowBudget: Math.max(1, size.rows - 7),
      focusRowId: stored?.focusedRowId,
      scrollAnchorRowId: stored?.scrollAnchorRowId });
    const normalizedExpanded = expandedPluginIds ?? new Set([
      ...projection.dependencies.defaultExpandedPluginIds,
      ...projection.dependents.defaultExpandedPluginIds,
    ]);
    const nextFocus = layout.focusIndex;
    const nextScroll = layout.viewport.offset;
    setExpandedDependencyPluginIds(normalizedExpanded);
    setFocus(nextFocus);
    setScrollOffset(nextScroll);
    dependencyGraphContexts.current.set(key, {
      expandedPluginIds: normalizedExpanded,
      focusedRowId: layout.focusRowId,
      scrollAnchorRowId: layout.scrollAnchorRowId,
    });
  }, [
    props.controller,
    route.name,
    route.name === 'pluginDependencies' || route.name === 'portableDependencies' ? route.pluginId : '',
    snapshot.viewModel,
    size.columns,
    size.rows,
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
  useLayoutEffect(() => {
    setBatchTargetOffset(snapshot.router.current.context.entityLineOffset ?? 0);
  }, [snapshot.router.currentFrameId, route.name,
    route.name === 'review' || route.name === 'result' ? route.operationId : '']);

  const activeTopField = route.name === 'configFieldEditor'
    || route.name === 'configObjectPropertyEditor'
    || route.name === 'configFieldAction'
    ? currentConfigPage?.groups.flatMap((group) => group.fields).find((field) => field.key === route.fieldKey)
    : undefined;
  const arrayItem = route.name === 'configFieldEditor' || route.name === 'configObjectPropertyEditor'
    ? route.arrayItem : undefined;
  const activeArrayKey = activeTopField?.definition.type === 'array' && configRoute
    ? `${configOwnerKey(configRoute)}\0${activeTopField.key}` : undefined;
  const activeArrayDraft = activeArrayKey ? arrayDrafts[activeArrayKey] : undefined;
  const itemValue = arrayItem && activeArrayDraft
    ? activeArrayDraft.rows.find((row) => row.rowId === arrayItem.rowId)?.value : undefined;
  const activeField: ConfigFieldViewModel | undefined = arrayItem && activeTopField?.definition.type === 'array'
    ? {
        ...activeTopField,
        type: activeTopField.definition.items.type,
        definition: activeTopField.definition.items,
        title: arrayItem.rowId === undefined ? '新增项' : `第 ${(activeArrayDraft?.rows.findIndex((row) => row.rowId === arrayItem.rowId) ?? 0) + 1} 项`,
        description: activeTopField.definition.items.description,
        choices: activeTopField.definition.items.choices?.presets,
        allowCustom: activeTopField.definition.items.choices?.allowCustom ?? true,
        value: itemValue, draftValue: itemValue, configured: itemValue !== undefined,
        min: activeTopField.definition.items.type === 'number' ? activeTopField.definition.items.validation?.minimum : undefined,
        max: activeTopField.definition.items.type === 'number' ? activeTopField.definition.items.validation?.maximum : undefined,
      }
    : activeTopField;
  useEffect(() => {
    if (!activeArrayKey || activeArrayDraft || !activeTopField || route.name !== 'configFieldEditor') return;
    const value = draftUpdates[activeTopField.key] ?? activeTopField.draftValue ?? activeTopField.value;
    setArrayDrafts((current) => ({ ...current, [activeArrayKey]: { ...createConfigArrayDraft(Array.isArray(value) ? value : undefined), evidence: currentConfigPage?.editEvidence } }));
  }, [activeArrayKey, activeArrayDraft, activeTopField, route.name]);
  useEffect(() => {
    if (route.name !== 'configFieldEditor' || route.editor !== 'array' || !activeArrayKey || !activeArrayDraft) return;
    const row = activeArrayDraft.rows[focus];
    if (row && row.rowId !== activeArrayDraft.selectedRowId) {
      setArrayDrafts((current) => ({ ...current, [activeArrayKey]: { ...activeArrayDraft, selectedRowId: row.rowId } }));
    }
  }, [route.name, route.name === 'configFieldEditor' ? route.editor : '', activeArrayKey, activeArrayDraft, focus]);
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
  useEffect(() => {
    if (route.name === 'configFieldAction' && activeField) {
      props.controller.replace({ ...route, name: 'configFieldEditor', editor: activeField.type });
    }
  }, [props.controller, route, activeField]);
  const activeObjectKey = activeField?.type === 'object' && configRoute
    ? `${configOwnerKey(configRoute)}\0${activeField.key}${arrayItem ? `\0${arrayItem.rowId ?? 'new'}` : ''}`
    : undefined;
  const objectValueFromUpdate = !arrayItem && activeField && Object.hasOwn(draftUpdates, activeField.key)
    && typeof draftUpdates[activeField.key] === 'object'
    ? draftUpdates[activeField.key] as PluginConfigObject
    : undefined;
  const activeCandidateMutation = !arrayItem && activeField ? configCandidate?.mutations[activeField.key] : undefined;
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
    const draft = arrayItem ? itemValue : candidate?.kind === 'set' ? candidate.value : draftUpdates[activeField.key];
    setInputValue(activeField.sensitive
      ? draft === undefined ? '' : String(draft)
      : typeof (draft ?? activeField.draftValue ?? activeField.value) === 'object'
        ? ''
        : String(draft ?? activeField.draftValue ?? activeField.value ?? ''));
    setInputError(undefined);
  }, [
    route.name,
    route.name === 'configFieldEditor' ? `${route.fieldKey}:${route.mode ?? ''}:${route.arrayItem ? route.arrayItem.rowId ?? 'new' : 'field'}` : '',
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
      ? snapshot.portableDraft.candidates.filter((candidate) => candidate.selected
        && queryMatches(query, candidate.name, candidate.shortDescription
          ?? candidate.description.split(/[。！？\n]/u)[0]))
      : snapshot.portableDraft.candidates.filter((candidate) => queryMatches(query,
        candidate.name, candidate.shortDescription ?? candidate.description.split(/[。！？\n]/u)[0]))
    : [];
  const supportsTechnicalDetails = !(route.name === 'pluginDependencies' && route.view !== 'removeBlocked'
    || route.name === 'pluginDependencyNode' || route.name === 'portableDependencies')
    && (snapshot.phase === 'error'
    || route.name === 'projectStatus'
    || Boolean(route.name === 'reviewPreparing' && snapshot.reviewPreparation?.code)
    || Boolean(route.name === 'progress' && snapshot.progress.messages.length > 0)
    || Boolean(route.name === 'review' && snapshot.activeReview?.technicalDetails?.length)
    || Boolean(route.name === 'issueDetail' && issue
      && issue.diagnostic.technical)
    || Boolean(route.name === 'pluginDependencies' && plugin)
    || route.name === 'catalogStoreRules'
    || portableVariantCandidates.length > 0
    || Boolean(route.name === 'portableBlocker' && plugin)
    || Boolean(route.name === 'configUnavailable' && plugin)
    || Boolean(route.name === 'result' && snapshot.result && 'operationKind' in snapshot.result
      && snapshot.result.operationKind === 'portableInstall'));
  const characterInput = isCharacterInputMode(route, searchFocus)
    || route.name === 'operationReportPreview' && reportSaveMode;
  const canOpenHelp = !tooSmall && !characterInput && !preparationRunning;
  useEffect(() => {
    props.onScreenChange?.(screenId);
  }, [props.onScreenChange, screenId]);

  const dependencyOverview = (candidate: PluginListItemViewModel | undefined): PluginDependencyOverviewViewModel | undefined =>
    candidate ? props.controller.getPluginDependencyOverview(candidate.pluginId) : undefined;

  let title = '管理你的 Agent 工作流插件';
  let description: string | undefined = '为 Codex 和 Claude Code 添加、设置或移除开发能力。';
  let breadcrumb = '首页';
  let context: string | undefined;
  let help = route.name === 'home'
    ? '↑↓ 移动 · Enter 选择 · ? 帮助 · q 退出'
    : '↑↓ 移动 · Enter 选择 · Esc 返回 · ? 帮助';
  let content: React.ReactNode;
  let actions: ActionItem[] = [];
  let readingText: string | undefined;
  let readerNavigation: { page: number; pageCount: number; move: (direction: -1 | 1) => void } | undefined;
  const helpBodyRows = Math.max(1, size.rows - (props.onSessionNavigation ? 10 : 8));
  let configCardNavigation: { key: string; page: number; pageCount: number } | undefined;
  let confirmationText: string | undefined;
  let referenceDetailPagination: { total: number; pageRows: number } | undefined;
  let confirmationPagination: { total: number; pageRows: number } | undefined;
  let pluginRows: PluginListRowViewModel[] = [];
  let bottomActions: ActionItem[] = [];
  let listQueryActions: ActionItem[] = [];
  let selectAllPortableCandidates: ActionItem | undefined;
  let togglePluginListFilter: (() => void) | undefined;
  let movePluginListSource: ((direction: -1 | 1) => void) | undefined;
  let choosePluginListFilter: ((filter: PluginInstallFilter) => void) | undefined;
  let choosePluginListSource: ((sourceId: string) => void) | undefined;
  let toggleProjectStatusFilter: (() => void) | undefined;
  let moveProjectSection: ((direction: -1 | 1) => void) | undefined;
  let moveSourceType: ((direction: -1 | 1) => void) | undefined;
  let moveContentType: ((direction: -1 | 1) => void) | undefined;
  let entityCardNavigation: { itemCount: number; factRows: number[]; lineLimit: number } | undefined;
  let graphLayout: ReturnType<typeof projectDependencyGraphView> | undefined;
  let graphProjection: ReturnType<typeof buildUnifiedDependencyGraphProjection> | undefined;
  let graphRowBudget = 1;
  let returnToPreviousInstallPlatform: (() => void) | undefined;
  let visibleConfigTabs: ConfigTab[] = [];
  let activeConfigTabId: string | undefined;
  const dynamicMenu = plugin && route.name === 'platform'
        ? buildPlatformActions(plugin, route.platform).filter((action) =>
          action.id === 'addScope' || !('scope' in action) || action.scope === platformSelectedScope)
        : undefined;
  let dynamicActionIds: string[] | undefined;
  let dynamicActionSignature: string | undefined;
  let effectiveFocus = focus;
  const pageActionBudget = (staticRows = 0): number => contentRowBudget({
    terminalRows: size.rows,
    description: Boolean(actionError ?? description),
    compact: policy.mode === 'compact',
    staticRows: staticRows
      + Math.max(0, wrapConsoleText(actionError ?? description ?? '', size.columns - 2).length - 1)
      + Math.max(0, wrapConsoleText(title, size.columns - 2).length - 1),
  });
  const detailCardContent = (
    subject: NonNullable<ReturnType<TuiController['getPluginDetailSubject']>>,
    completionLines: string[] = [],
  ): React.JSX.Element => {
    const cardWidth = size.columns - 2;
    const card = pluginDetailCardLayout(subject, cardWidth);
    const availableRows = pageActionBudget(completionLines.length);
    // Compact actions use one row each; paging adds one row inside the card.
    const actionRows = Math.min(3, actions.filter((action) => action.role !== 'navigation').length);
    const needsPaging = card.fullHeight > availableRows - actionRows;
    const lineLimit = needsPaging ? Math.max(1, availableRows - actionRows - 3) : undefined;
    const pageCount = lineLimit ? Math.max(1, Math.ceil(card.factRows / lineLimit)) : 1;
    const page = lineLimit ? Math.min(pageCount, Math.floor(batchTargetOffset / lineLimit) + 1) : 1;
    const lineOffset = lineLimit ? (page - 1) * lineLimit : 0;
    if (lineLimit) readerNavigation = { page, pageCount, move: (direction) => {
      setBatchTargetOffset((Math.min(pageCount, Math.max(1, page + direction)) - 1) * lineLimit);
    } };
    const cardHeight = entityCardWindowHeight(card, lineOffset, lineLimit);
    currentActionViewportLineBudget = Math.max(1,
      pageActionBudget(completionLines.length) - cardHeight);
    const viewport = actionViewport(actions, true, focus, scrollOffset,
      currentActionViewportLineBudget);
    help = [
      ...(actions.length > 0 ? ['↑↓ 选择动作'] : []),
      ...(needsPaging ? ['←→ 翻信息'] : []),
      ...(actions[focus]?.run && !actions[focus]?.disabled ? ['Enter 选择'] : []),
      'Esc 返回',
    ].join(' · ');
    return <Box flexDirection="column">
      {completionLines.map((line, index) => <Text key={`completion:${index}`}
        color={tuiTheme.statusColors.success}>{line}</Text>)}
      <PluginDetailCard subject={subject} width={cardWidth}
        lineOffset={lineOffset} lineLimit={lineLimit} />
      <SemanticRows actions={actions} focus={focus} kind="action" compact
        offset={viewport.offset} limit={viewport.limit} />
    </Box>;
  };
  const readingPage = (
    text: string,
    columns: number,
    rows: number,
    offset: 'batch' | 'scroll' | 'portable' = 'batch',
  ): React.JSX.Element => {
    const current = offset === 'scroll' ? scrollOffset
      : offset === 'portable' ? portableResultDetailOffset : batchTargetOffset;
    const page = readerPage({ text, columns, rows, page: current + 1 });
    readerNavigation = {
      page: page.page,
      pageCount: page.pageCount,
      move: (direction) => {
        const next = Math.min(page.pageCount, Math.max(1, page.page + direction)) - 1;
        if (offset === 'scroll') setScrollOffset(next);
        else if (offset === 'portable') setPortableResultDetailOffset(next);
        else setBatchTargetOffset(next);
      },
    };
    return <Reader text={text} columns={columns} rows={rows} page={page.page} />;
  };
  const pagedItems = (total: number, rows: number, offset = batchTargetOffset) =>
    paginateWrappedRows({
      lines: Array.from({ length: total }, (_, index) => String(index)),
      rows,
      page: Math.floor(offset / Math.max(1, rows)) + 1,
    });
  const dependencyPlacementStaticRows = (policy.mode === 'compact' ? 3 : 10)
    + (snapshot.installPlacementDraft?.exactRootTargets?.length ?? 0);
  const actionViewportStaticRows = route.name === 'dependencyPlacement'
    ? dependencyPlacementStaticRows
    : route.name === 'pluginDetail' ? policy.mode === 'compact' ? 6 : 8
    : route.name === 'operationHistory' ? 4
      : route.name === 'operationReportPreview' ? 5 : 0;
  let currentActionViewportLineBudget = pageActionBudget(actionViewportStaticRows);
  const responsiveBudget = (compactRows: number, standardRows: number): number => {
    const baseline = policy.mode === 'compact' ? 18 : 24;
    const base = policy.mode === 'compact' ? compactRows : standardRows;
    return base + Math.max(0, size.rows - baseline);
  };
  const resolveSourceTechnicalDiagnostic = (sourceId: string): DiagnosticSummaryViewModel => {
    const overview = props.controller.getSourceOverview(sourceId);
    const freshness = props.controller.getCatalogFreshness(sourceId);
    const diagnostic = sourceDiagnostic(
      sourceId,
      overview.health?.state ?? overview.source?.state,
      overview.detail,
      props.controller.getCatalogGeneration(sourceId),
      freshness,
    );
    const evidenceContext: NonNullable<DiagnosticSummaryViewModel['technical']>['context'] = [
      { key: 'sourcePolicy', value: overview.detail?.type === 'path'
        ? 'path' : overview.detail?.refPolicy === 'explicit' ? 'explicit' : 'cliChannel' },
      ...(freshness?.checkedAt
        ? [{ key: 'freshness' as const, value: freshness.checkedAt }]
        : []),
      ...(freshness?.candidate
        ? [{ key: 'candidate' as const, value: JSON.stringify({
            catalogVersion: freshness.candidate.catalogVersion,
            requestedRef: freshness.candidate.requestedRef,
            resolvedCommit: freshness.candidate.resolvedCommit,
          }) }]
        : []),
    ];
    if (diagnostic) return {
      ...diagnostic,
      ...(diagnostic.technical ? { technical: {
        ...diagnostic.technical,
        ...(diagnostic.technical.requestedRef || !overview.detail?.requestedRef
          ? {} : { requestedRef: overview.detail.requestedRef }),
        ...(diagnostic.technical.resolvedCommit || !overview.detail?.resolvedCommit
          ? {} : { resolvedCommit: overview.detail.resolvedCommit }),
        context: [...(diagnostic.technical.context ?? []), ...evidenceContext],
      } } : {}),
    };
    return {
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
        context: evidenceContext,
      },
    };
  };
  const moveBatchTargetPage = (total: number, pageRows: number, direction: -1 | 1): void => {
    setBatchTargetOffset((value) => {
      const page = pagedItems(total, pageRows, value);
      return pagedItems(total, pageRows, (page.page + direction - 1) * pageRows).offset;
    });
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
    projectFlowToken.current += 1;
    projectFlowEnterBusy.current = false;
    if (projectFlow?.stage === 'preparing') props.controller.cancelProjectPreparation();
    setProjectFlow(undefined);
    props.controller.updatePageContext({
      focusIndex: route.name === 'projectStatus' || route.name === 'platform' ? effectiveFocus : focus,
      scrollOffset,
      entityLineOffset: entityCardNavigation || route.name === 'pluginDetail' ? batchTargetOffset : undefined,
      query,
      installFilter,
      sourceTabId: route.name === 'pluginList' ? route.sourceId ?? 'all' : undefined,
      focusedEntityId: route.name === 'pluginList'
        ? pluginRows[focus]?.pluginId
        : route.name === 'pluginContent' ? actions[focus]?.actionId?.replace(/^content:/u, '')
        : route.name === 'batchSelection' ? actions[focus]?.pluginId
        : route.name === 'projectStatus' ? actions[effectiveFocus]?.pluginId
          : route.name === 'sourceList' ? actions[focus]?.actionId?.replace(/^source:/u, '')
            : route.name === 'portableSkillSelect' ? actions[focus]?.actionId : undefined,
      ...(route.name === 'projectStatus' || route.name === 'platform'
        ? { focusedActionId: actions[effectiveFocus]?.actionId } : {}),
    });
    props.controller.push(next);
    if (route.name === 'pluginContent') setContentReader(undefined);
    setFocus(0);
    if (next.name === 'pluginDetail' || next.name === 'sourceDetail'
      || next.name === 'projectStatus') setBatchTargetOffset(0);
    setScrollOffset(0);
    setQuery('');
    setSearchFocus(false);
    if (next.name === 'pluginList') {
      setInstallFilter(next.mode === 'installed' ? 'installed' : 'all');
    }
    setShowTechnical(false);
    setActionError(undefined);
  };
  const beginProjectTask = (
    request: Parameters<TuiController['prepareProjectTask']>[0],
    returnTo: 'project' | 'targets' | 'task' = 'project',
    task?: SplitTaskContext,
  ): void => {
    if (projectFlowEnterBusy.current) return;
    projectFlowEnterBusy.current = true;
    if (returnTo === 'project') projectPageAnchor.current = batchTargetOffset;
    const token = ++projectFlowToken.current;
    setBatchTargetOffset(0);
    setProjectFlow({ stage: 'preparing', request: request.kind, returnTo, ...(task ? { task } : {}) });
    void props.controller.prepareProjectTask(request).then((plan) => {
      if (projectFlowToken.current !== token) return;
      projectFlowEnterBusy.current = false;
      setProjectFlow({ stage: 'review', plan, returnTo, ...(task ? { task } : {}), focus: 0 });
    }).catch((error) => {
      if (projectFlowToken.current !== token) return;
      projectFlowEnterBusy.current = false;
      setProjectFlow({ stage: 'result',
        errorCode: safeDiagnosticCode(error instanceof Error ? error.message : undefined,
        'projectRecoveryPreparationFailed'), ...(task ? { task } : {}), focus: 0 });
    });
  };
  const closeProjectFlow = (): void => {
    setProjectFlow(undefined);
    if (!projectFlow || !('task' in projectFlow) || !projectFlow.task) {
      setBatchTargetOffset(projectPageAnchor.current);
    }
  };
  const executeProjectReview = (plan: ProjectTuiPlan, task?: SplitTaskContext): void => {
    if (projectFlowEnterBusy.current) return;
    projectFlowEnterBusy.current = true;
    const token = ++projectFlowToken.current;
    setProjectFlow({ stage: 'progress', plan, ...(task ? { task } : {}) });
    void props.controller.executeProjectTask(plan).then((outcome) => {
      if (projectFlowToken.current !== token) return;
      projectFlowEnterBusy.current = false;
      setBatchTargetOffset(0);
      setProjectFlow({ stage: 'result', plan,
        ...(outcome.kind === 'recovery' ? { receipt: outcome.receipt } : { changed: outcome.changed }),
        ...(task ? { task } : {}), focus: 0 });
      void props.controller.refreshProjectInventory();
    }).catch((error) => {
      if (projectFlowToken.current !== token) return;
      projectFlowEnterBusy.current = false;
      setProjectFlow({ stage: 'result', plan,
        errorCode: safeDiagnosticCode(error instanceof Error ? error.message : undefined,
          'projectRecoveryFailed'), ...(task ? { task } : {}), focus: 0 });
    });
  };
  const closeBatchSelectionTools = (): void => {
    if (!batchDraft) return;
    const candidates = batchCandidates(batchDraft);
    const anchor = batchSelectionAnchor.current;
    const retained = anchor?.frameId === snapshot.router.currentFrameId
      ? candidates.findIndex((candidate) => candidate.pluginId === anchor.pluginId) : -1;
    const nextFocus = retained >= 0 ? retained
      : Math.min(anchor?.index ?? 0, Math.max(0, candidates.length - 1));
    setBatchDraft((current) => current ? { ...current, showSelectionTools: false } : current);
    setFocus(nextFocus);
    setScrollOffset(Math.min(anchor?.scrollOffset ?? 0, nextFocus));
  };
  const toggleTechnical = (): void => {
    if (portableResultDetailOpen) setFocus(portableResultDetailReturnFocus.current);
    setPortableResultDetailOpen(false);
    setPortableResultDetailOffset(0);
    if (route.name === 'projectStatus' && dynamicActionIds && dynamicActionSignature !== undefined) {
      const recheck = actions.findIndex((action) => action.actionId === 'project-recheck');
      dynamicMenuFocus.current = { routeKey, actionIds: dynamicActionSignature,
        focusedActionId: 'project-recheck' };
      setFocus(Math.max(0, recheck));
      setScrollOffset(0);
    }
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
    } else if (restoredFrame.route.name === 'projectStatus') {
      const actionId = restored.focusedActionId
        ?? (restored.focusedEntityId ? `project-root:${restored.focusedEntityId}` : 'project-recheck');
      dynamicMenuFocus.current = {
        routeKey: JSON.stringify(restoredFrame.route), actionIds: '', focusedActionId: actionId,
      };
    } else if (restoredFrame.route.name === 'platform') {
      dynamicMenuFocus.current = {
        routeKey: JSON.stringify(restoredFrame.route), actionIds: '',
        focusedActionId: restored.focusedActionId,
      };
    } else if (restoredFrame.route.name === 'pluginContent') {
      const overview = props.controller.getPluginContentOverview(restoredFrame.route.pluginId);
      const items = (overview?.items ?? []).filter((item) =>
        contentMatches(restored.query ?? '', item)
        && (restored.contentTypeTab === undefined || restored.contentTypeTab === 'all'
          || item.type === restored.contentTypeTab));
      const index = items.findIndex((item) => item.id === restored.focusedEntityId);
      itemCount = items.length + 2;
      restoredFocus = index >= 0 ? index : Math.min(restoredFocus, Math.max(0, itemCount - 1));
    } else if (restoredFrame.route.name === 'batchSelection' && batchDraft) {
      const candidates = batchCandidates(batchDraft);
      const entityIndex = candidates.findIndex((candidate) => candidate.pluginId === restored.focusedEntityId);
      itemCount = candidates.length + 3;
      restoredFocus = entityIndex >= 0 ? entityIndex : Math.min(restoredFocus, Math.max(0, itemCount - 1));
    } else if (restoredFrame.route.name === 'sourceList') {
      const sources = matchingSources(props.controller, restored.query ?? '', restored.sourceTypeTab ?? 'all');
      itemCount = sources.length + 3;
      const entityIndex = restored.focusedEntityId
        ? sources.findIndex((source) => source.id === restored.focusedEntityId)
        : -1;
      restoredFocus = entityIndex >= 0
        ? entityIndex
        : Math.min(restoredFocus, Math.max(0, itemCount - 1));
    } else if (restoredFrame.route.name === 'portableSkillSelect' && snapshot.portableDraft) {
      const candidates = snapshot.portableDraft.candidates.filter((candidate) =>
        queryMatches(restored.query ?? '', candidate.name,
          candidate.shortDescription ?? candidate.description.split(/[。！？\n]/u)[0]));
      const entityIndex = candidates.findIndex((candidate) =>
        `skill:${candidate.providerPluginId}:${candidate.name}` === restored.focusedEntityId);
      itemCount = candidates.length + 2;
      restoredFocus = entityIndex >= 0 ? entityIndex : Math.min(restoredFocus, Math.max(0, itemCount - 1));
    }
    const dynamicMenuRoute = restoredFrame.route.name === 'projectStatus' || restoredFrame.route.name === 'platform';
    let restoredScroll = dynamicMenuRoute
      ? restored.scrollOffset ?? 0
      : Math.min(restored.scrollOffset ?? 0, Math.max(0, (itemCount ?? 1) - 1));
    if (!dynamicMenuRoute) {
      if (restoredFocus < restoredScroll) restoredScroll = restoredFocus;
      else if (restoredFocus >= restoredScroll + 4) restoredScroll = Math.max(0, restoredFocus - 3);
    }
    setFocus(restoredFocus);
    setScrollOffset(restoredScroll);
    setBatchTargetOffset(restored.entityLineOffset ?? 0);
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
    setQuery('');
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
    if (route.name === 'pluginContent') setContentReader(undefined);
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
    setSplitTaskReview(undefined);
    if (unifiedProjectScope) {
      if (intent.kind === 'pluginWrite' && intent.scope === 'project') {
        const agents = projectAgentsForPlatform(intent.platform);
        const wholeRemovedCleanup = intent.action === 'cleanup' && !intent.force
          && snapshot.projectInventory?.recovery?.inventory?.some((root) =>
            root.pluginId === intent.pluginId && root.sourceState === 'ready'
            && root.blockers.some((blocker) => blocker.code === 'pluginUnavailable'));
        beginProjectTask({ kind: 'recovery',
          command: intent.action === 'refreshAndSync' ? 'sync' : intent.action,
          selectors: [intent.pluginId],
          ...(!wholeRemovedCleanup ? { targets: agents,
            exactTargets: agents.map((agent) => ({ pluginId: intent.pluginId, agent })) } : {}),
          ...(intent.action === 'refreshAndSync' ? { refresh: true } : {}),
          ...(intent.force ? { force: true } : {}),
          ...(intent.scriptTimeoutMs !== undefined ? { scriptTimeoutMs: intent.scriptTimeoutMs } : {}),
          ...(intent.action === 'install' && intent.dependencyScopeOverrides?.length
            ? { dependencyScopeOverrides: intent.dependencyScopeOverrides } : {}),
        });
        return;
      }
      if (intent.kind === 'pluginWriteBatch' && (intent.scope === 'project'
        || ((intent.selection.kind === 'targets' || intent.selection.kind === 'currentProjectIntentTargets')
          && intent.selection.targets.some((target) => target.scope === 'project')))) {
        if ((intent.selection.kind === 'targets' || intent.selection.kind === 'currentProjectIntentTargets')
          && intent.selection.targets.some((target) => target.scope !== 'project')) {
          setActionError('个人与项目恢复目标需要分别处理。');
          return;
        }
        const exactTargets = intent.selection.kind === 'targets'
          || intent.selection.kind === 'currentProjectIntentTargets'
          ? intent.selection.targets.filter((target) => target.scope === 'project')
            .map((target) => ({ pluginId: target.pluginId,
              agent: projectAgentsForPlatform(target.platform)[0]! }))
          : intent.selection.kind === 'selected'
            ? intent.selection.pluginIds.flatMap((pluginId) => projectAgentsForPlatform(intent.platform)
              .map((agent) => ({ pluginId, agent }))) : undefined;
        const selectors = intent.selection.kind === 'selected' ? intent.selection.pluginIds
          : exactTargets ? [...new Set(exactTargets.map((target) => target.pluginId))] : [];
        beginProjectTask({ kind: 'recovery', command: intent.action, selectors,
          ...(exactTargets ? { exactTargets,
            targets: [...new Set(exactTargets.map((target) => target.agent))] } : {}),
          ...(intent.scriptTimeoutMs !== undefined ? { scriptTimeoutMs: intent.scriptTimeoutMs } : {}),
          ...(intent.action === 'install' && intent.dependencyScopeOverrides?.length
            ? { dependencyScopeOverrides: intent.dependencyScopeOverrides } : {}),
        });
        return;
      }
      if (intent.kind === 'pluginWriteTask' && intent.targets.some((target) => target.scope === 'project')) {
        if (intent.targets.some((target) => target.scope !== 'project')) {
          setActionError('个人与项目恢复目标需要分别处理。');
          return;
        }
        const exactTargets = intent.targets.map((target) => ({ pluginId: target.pluginId,
          agent: projectAgentsForPlatform(target.platform)[0]! }));
        beginProjectTask({ kind: 'recovery', command: 'sync',
          selectors: [...new Set(exactTargets.map((target) => target.pluginId))],
          exactTargets, targets: [...new Set(exactTargets.map((target) => target.agent))],
          ...(intent.scriptTimeoutMs !== undefined ? { scriptTimeoutMs: intent.scriptTimeoutMs } : {}),
        });
        return;
      }
    }
    pendingReviewIntentRef.current = intent;
    setPendingReviewIntent(intent);
    const underlyingResultRoute = returnRoute ?? (route.name === 'result' && snapshot.result && 'returnRoute' in snapshot.result
      ? snapshot.result.returnRoute
      : undefined);
    props.controller.updatePageContext({
      focusIndex: route.name === 'projectStatus' || route.name === 'platform' ? effectiveFocus : focus,
      scrollOffset,
      query,
      installFilter,
      sourceTabId: route.name === 'pluginList' ? route.sourceId ?? 'all' : undefined,
      ...(route.name === 'projectStatus' || route.name === 'platform'
        ? { focusedActionId: actions[effectiveFocus]?.actionId } : {}),
    });
    props.controller.startReviewPreparation(intent, underlyingResultRoute);
    setFocus(0);
    setScrollOffset(0);
  };
  const startSplitTaskScope = (context: SplitTaskContext, currentScope: Scope): void => {
    const selected = context.targets.filter((target) => target.scope === currentScope);
    const task = { ...context, currentScope };
    if (currentScope === 'project') {
      const exactTargets = selected.map((target) => ({ pluginId: target.pluginId,
        agent: projectAgentsForPlatform(target.platform)[0]! }));
      beginProjectTask({ kind: 'recovery', command: 'sync',
        selectors: [...new Set(exactTargets.map((target) => target.pluginId))],
        targets: [...new Set(exactTargets.map((target) => target.agent))], exactTargets,
      }, 'task', task);
      return;
    }
    beginReview({ kind: 'pluginWriteTask', goal: context.goal, targets: selected,
      executionPolicy: context.executionPolicy }, context.returnRoute);
    setSplitTaskReview(task);
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
    if (unifiedProjectScope
      && new Set(candidates.map((candidate) => candidate.target.scope)).size > 1) return;
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
    unifiedProjectScope,
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
    setFocus(Math.min(focus, Math.max(0, pluginRows.length - 1)));
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
      && props.controller.listPluginWriteBatchTargets(
        'cleanup', [candidate.plugin.pluginId],
      ).length === 0
      && !batchTaskPluginIds.has(candidate.plugin.pluginId)
      ? '没有可用于批量处理的实际目标'
    : draft.action === 'install' && candidate.plugin.catalogEntryMissing
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
    layout: ReturnType<typeof projectDependencyGraphView>,
    expandedPluginIds: ReadonlySet<string>,
    focusIndex: number,
    offset: number,
    portable = false,
  ): void => {
    dependencyGraphContexts.current.set(
      dependencyGraphContextKey(pluginId, portable ? 'portable' : 'dependencies'),
      {
        expandedPluginIds: new Set(expandedPluginIds),
        ...(layout.rows[focusIndex] ? { focusedRowId: layout.rows[focusIndex]!.id } : {}),
        ...(layout.rows[offset] ? { scrollAnchorRowId: layout.rows[offset]!.id } : {}),
      },
    );
  };
  const renderDependencyGraph = (pluginId: string, portable: boolean): void => {
    graphProjection = buildUnifiedDependencyGraphProjection({
      overviews: props.controller.listPluginDependencyOverviews(),
      rootPluginId: pluginId,
      ...(expandedDependencyPluginIds ? { expandedPluginIds: expandedDependencyPluginIds } : {}),
    });
    graphRowBudget = pageActionBudget(3
      + Number(portable && snapshot.portableDraft !== undefined)
      + (graphProjection.status.state === 'invalid' ? 4 : 0));
    const ordered = projectDependencyGraphView(graphProjection, {
      columns: size.columns - 2, rowBudget: graphRowBudget,
    });
    const currentId = ordered.rows[focus]?.id;
    const anchorId = ordered.rows[scrollOffset]?.id;
    graphLayout = projectDependencyGraphView(graphProjection, {
      columns: size.columns - 2, rowBudget: graphRowBudget,
      focusRowId: currentId, scrollAnchorRowId: anchorId,
    });
    const layout = graphLayout;
    const projection = graphProjection;
    actions = layout.rows.map((row) => ({
      actionId: row.id,
      label: row.node.displayName,
      run: () => {
        persistUnifiedDependencyGraphContext(pluginId, layout,
          expandedDependencyPluginIds ?? new Set([
            ...projection.dependencies.defaultExpandedPluginIds,
            ...projection.dependents.defaultExpandedPluginIds,
          ]), focus, layout.viewport.offset, portable);
        setGraphEvidenceOpen(false);
        setGraphPortableSelectionOpen(false);
        go({ name: 'pluginDetail', pluginId: row.node.pluginId });
      },
    }));
    const selected = layout.rows[focus] ?? layout.rows[layout.focusIndex];
    if (portable && graphPortableSelectionOpen && snapshot.portableDraft) {
      readingText = [
        `本次选择 ${snapshot.portableDraft.selectedCount} 个 Skills`,
        ...snapshot.portableDraft.candidates.filter((candidate) => candidate.selected)
          .map((candidate) => `${candidate.name} · ${candidate.providerDisplayName} · ${candidate.providerPluginId}`),
        '安装位置在最终汇总中确认。',
      ].join('\n');
      content = <Box flexDirection="column">
        {readingPage(readingText, size.columns - 2, pageActionBudget(2))}
      </Box>;
      help = '←→/PgUp/PgDn 翻页 · y 复制全文 · Esc 返回关系图';
    } else if (graphEvidenceOpen && selected?.node.edge) {
      readingText = [
        `${selected.node.displayName} · ${selected.node.edge.declared ? '已声明' : '当前已验证'}`,
        ...dependencyEvidenceLines(selected.node,
          props.controller.getPluginDetailSubject(selected.node.pluginId)),
      ].join('\n');
      content = <Box flexDirection="column">
        {readingPage(readingText, size.columns - 2, pageActionBudget(2))}
      </Box>;
      help = '←→/PgUp/PgDn 翻页 · y 复制全文 · Esc 返回关系图';
    } else {
      const selectedHasEdge = selected?.node.edge !== undefined;
      help = `↑↓ 选择节点 · → 展开 · ← 收起 · Enter 插件详情${selectedHasEdge ? ' · r 引用证据' : ''}${portable ? ' · p 已选 Skills' : ''} · Esc 返回`;
      content = <Box flexDirection="column">
        <StaticRow title="检查范围" value="当前项目和个人位置；其他项目未确认" status="muted" compact />
        {projection.status.state === 'invalid'
          ? <Callout status="error" title="依赖关系无效" description={projection.status.message} /> : null}
        <DependencyGraphView projection={projection} columns={size.columns - 2}
          rowBudget={graphRowBudget}
          focusRowId={layout.focusRowId} scrollAnchorRowId={layout.scrollAnchorRowId} />
        {selectedHasEdge ? <Box width={size.columns - 2} justifyContent="space-between">
          <Text color={tuiTheme.colors.muted}>查看当前边的完整位置引用</Text><KeyCap>r</KeyCap>
        </Box> : null}
        {portable && snapshot.portableDraft ? <Text color={tuiTheme.colors.muted}>
          本次选择 {snapshot.portableDraft.selectedCount} 个 Skills；安装位置在最终汇总确认。
        </Text> : null}
      </Box>;
    }
  };
  const toggleBatchPlugin = (pluginId: string): void => {
    setBatchDraft((current) => current ? {
      ...current,
      selectedPluginIds: current.selectedPluginIds.includes(pluginId)
        ? current.selectedPluginIds.filter((candidate) => candidate !== pluginId)
        : [...current.selectedPluginIds, pluginId],
    } : current);
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
      if (route.name === 'portableBlocker' && snapshot.portableDraft?.pluginId === pluginId) {
        await props.controller.refreshPortableInstallDraft(pluginId);
        props.controller.resetPortableFlowToPreview(
          pluginId,
          { name: 'portableSkillSelect', pluginId },
          true,
        );
      } else {
        await props.controller.preparePortableInstall(
          pluginId,
          route.name === 'portableBlocker' ? 'replace' : 'push',
        );
      }
      setFocus(0);
      setPortableSelectionView('all');
      setScrollOffset(0);
      setActionError(undefined);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') return;
      const blocker = extractPortableError(error);
      const operationRecordId = props.controller.recordUiFailure(error, {
        code: blocker.diagnosticCode,
        stage: 'prepare-portable',
      });
      const target = { name: 'portableBlocker', pluginId, ...blocker, operationRecordId } as const;
      if (props.controller.snapshot.router.current.route.name === 'portableBlocker'
        || props.controller.snapshot.router.current.route.name === 'portablePreparing') {
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
      const operationRecordId = props.controller.recordUiFailure(error, {
        code: blocker.diagnosticCode,
        stage: 'prepare-portable',
      });
      const target = { name: 'portableBlocker', pluginId, ...blocker, operationRecordId } as const;
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
    if (selectedScope === 'project' && snapshot.projectInventory?.recovery) {
      beginReview({ kind: 'pluginWrite', action: 'cleanup', pluginId,
        platform, scope: 'project', force: true });
      return;
    }
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
  const fieldValueText = (field: ConfigFieldViewModel, value: unknown, full = false, configured = value !== undefined): string =>
    presentConfigValue({
      definition: field.definition,
      value,
      configured,
      privateValue: field.sensitive,
      summary: field.summary,
      itemSummary: field.itemSummary,
      full,
    }).text;
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
    return fieldValueText(field, value);
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
    if (arrayItem && activeArrayKey && activeArrayDraft && activeField) {
      const issues = validatePluginConfigValue(activeField.definition, value, key);
      if (issues.length) { setObjectError(issues.map(objectIssueText).join('；')); return; }
      const next = editConfigArrayDraft(activeArrayDraft, { kind: 'set', rowId: arrayItem.rowId, value: value as PluginConfigScalar | PluginConfigObject });
      setArrayDrafts((current) => ({ ...current, [activeArrayKey]: { ...next, evidence: activeArrayDraft.evidence } }));
      if (activeObjectKey) setObjectDrafts((current) => Object.fromEntries(Object.entries(current).filter(([owner]) => owner !== activeObjectKey)));
      back();
      const index = next.rows.findIndex((row) => row.rowId === next.selectedRowId);
      props.controller.updatePageContext({ focusIndex: index, scrollOffset: index });
      setFocus(index);
      setScrollOffset(index);
      return;
    }
    if (activeField?.definition.type === 'array' && activeArrayKey && activeArrayDraft
      && activeArrayDraft.initial !== undefined && configValuesEqual(activeArrayDraft.initial, value)) {
      setArrayDrafts((current) => Object.fromEntries(Object.entries(current).filter(([owner]) => owner !== activeArrayKey)));
      back();
      return;
    }
    openConfigTarget({
      pluginId: configRoute.pluginId,
      fieldKey: key,
      groupId: snapshot.router.current.context.configGroupId,
      mutations: { [key]: { kind: 'set', value } },
      ...(activeArrayDraft?.evidence ? { editEvidence: activeArrayDraft.evidence } : {}),
    });
  };
  const editArray = (edit: ConfigArrayEdit): void => {
    if (!activeArrayKey || !activeArrayDraft) return;
    const next = editConfigArrayDraft(activeArrayDraft, edit);
    setArrayDrafts((current) => ({ ...current, [activeArrayKey]: { ...next, evidence: activeArrayDraft.evidence } }));
    setObjectError(undefined);
    const index = Math.max(0, next.rows.findIndex((row) => row.rowId === next.selectedRowId));
    setFocus(index);
    setScrollOffset(index);
  };
  const openArrayItem = (rowId?: string): void => {
    if (!activeField || activeField.definition.type !== 'array' || !configRoute) return;
    setObjectError(undefined);
    go({
      name: 'configFieldEditor', pluginId: configRoute.pluginId, layer: configRoute.layer,
      fieldKey: activeField.key, editor: activeField.definition.items.type,
      ...(activeField.definition.items.choices ? { mode: 'choices' as const } : {}),
      arrayItem: { rowId },
    });
  };
  const commitArray = (): void => {
    if (!activeField || activeField.definition.type !== 'array' || !activeArrayDraft || !activeArrayKey) return;
    const value = arrayDraftValue(activeArrayDraft);
    const issues = validatePluginConfigValue(activeField.definition, value, activeField.key);
    if (issues.length) { setObjectError(issues.slice(0, 2).map(objectIssueText).join('；')); return; }
    if (!arrayDraftChanged(activeArrayDraft)) {
      setArrayDrafts((current) => Object.fromEntries(Object.entries(current).filter(([key]) => key !== activeArrayKey)));
      back();
      return;
    }
    updateDraft(activeField.key, value);
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
  ): string => {
    const index = issue.path.segments?.find((part) => typeof part === 'number');
    const itemDefinition = activeTopField?.definition.type === 'array' ? activeTopField.definition.items : undefined;
    const property = issue.path.property;
    const label = property && itemDefinition?.type === 'object'
      ? itemDefinition.properties?.[property]?.title ?? property : property ?? activeField?.title ?? issue.path.field;
    return `${index === undefined ? '' : `第 ${Number(index) + 1} 项／`}${label}：${issue.message}`;
  };
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
      ...(arrayItem ? { arrayItem } : {}),
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
    const editEvidence = { ...previous.editEvidence };
    for (const [key, mutation] of Object.entries(configCandidate.mutations)) {
      const field = fields.get(key)!;
      if (configCandidate.editEvidence) editEvidence[key] = configCandidate.editEvidence;
      else delete editEvidence[key];
      if (mutation.kind === 'set') {
        removes.delete(key);
        if (field.configured && configValuesEqual(field.draftValue ?? field.value, mutation.value)) {
          delete updates[key];
          delete editEvidence[key];
        } else updates[key] = mutation.value;
      } else {
        delete updates[key];
        if (field.configured) removes.add(key);
        else removes.delete(key);
      }
    }
    const next = { ...configDrafts, [layer.scope]: { updates, removes: [...removes], editEvidence } };
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
    if (configCandidate.fieldKey) {
      const owner = `${configCandidate.pluginId}\0${configCandidate.fieldKey}`;
      setArrayDrafts((current) => Object.fromEntries(Object.entries(current).filter(([key]) => key !== owner)));
    }
    setConfigDrafts(next);
    setDirty(Object.keys(next).length > 0);
    setConfigCandidate(undefined);
    setFocus(target?.focusIndex ?? 0);
    setScrollOffset(0);
  };
  useEffect(() => {
    if (route.name !== 'configLayer' || !configCandidate) return;
    const scopes = (['project', 'user'] as const).filter((scope) => {
      const page = configLayerPages[scope];
      if (!page) return false;
      const fields = page.groups.flatMap((group) => group.fields);
      return Object.entries(configCandidate.mutations).every(([key, mutation]) => {
        const field = fields.find((entry) => entry.key === key);
        return field && (mutation.kind === 'set' ? configFieldCanSet(field) : configFieldCanUnset(field));
      });
    });
    if (scopes.length === 1) {
      openConfigLayerTarget({ scope: scopes[0]! });
      setConfigActionError(`仅可保存到${configLayerLabel({ scope: scopes[0]! })}；已加入待保存修改。`);
    }
  }, [route.name, configCandidate, configLayerPages]);
  const configChanges = (
    page: ConfigPageViewModel,
    draft: ConfigLayerDraft,
  ): NonNullable<Extract<OperationIntent, { kind: 'configSaveBatch' }>['groups'][number]['changes']> => {
    const fields = page.groups.flatMap((group) => group.fields);
    return [...Object.keys(draft.updates), ...draft.removes.filter((key) => !Object.hasOwn(draft.updates, key))]
      .map((key) => {
        const field = fields.find((candidate) => candidate.key === key)!;
        const beforeObject = field?.definition.type === 'object'
          && typeof field.draftValue === 'object' && !Array.isArray(field.draftValue) ? field.draftValue : undefined;
        const updatedValue = draft.updates[key];
        const afterObject = field?.definition.type === 'object'
          && typeof updatedValue === 'object' && !Array.isArray(updatedValue) ? updatedValue : undefined;
        const childSummary = (property: string, value: PluginConfigScalar | undefined): string => {
          if (value === undefined) return '未设置';
          if (field.sensitive || field.definition.type !== 'object') return '已设置';
          const definition = field.definition.properties?.[property]
            ?? (field.definition.additionalProperties === false
              ? undefined
              : field.definition.additionalProperties);
          if (definition?.sensitive) return '已设置';
          if (typeof value === 'boolean') return value ? '开启' : '关闭';
          return value === '' ? '（空字符串）' : safeConfigText(String(value));
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
          : fieldValueText(field, updatedValue, true);
        return {
          key,
          title: field?.title ?? key,
          before: field?.definition.type === 'array' && !field.configured && field.effectiveValue !== undefined
            ? `未设置（当前有效列表：${fieldValueText(field, field.effectiveValue, true)}）`
            : field ? fieldValueText(field, field.draftValue ?? field.value, true, field.configured) : '未设置',
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
      return Object.keys(updates).length + removes.length > 0 ? [[scope, { updates, removes,
        ...(draft.editEvidence ? { editEvidence: Object.fromEntries(Object.entries(draft.editEvidence)
          .filter(([key]) => Object.hasOwn(updates, key))) } : {}),
      }]] : [];
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
        ...(draft.editEvidence ? { editEvidence: draft.editEvidence } : {}),
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
    if (route.name === 'configSave' && route.view !== 'changes' && configDraftCount > 0 && currentConfigPage) {
      props.controller.replace({ name: 'configFields', pluginId: route.pluginId, layer: route.layer });
      beginConfigSave(true);
    }
  }, [route.name, route.name === 'configSave' ? route.view : undefined, currentConfigPage, configDraftCount]);
  useEffect(() => {
    if (route.name !== 'sourceSave' || route.view === 'changes' || sourceDraft?.owner !== route.owner) return;
    props.controller.replace({ name: 'sourceEdit', sourceId: sourceDraft.sourceId, owner: sourceDraft.owner });
    beginSourceReview(sourceDraft, false);
  }, [route.name, route.name === 'sourceSave' ? route.view : undefined, sourceDraft]);
  useEffect(() => {
    const intent = pendingReviewIntentRef.current;
    if (route.name !== 'review' || intent?.kind !== 'configSaveBatch' || !intent.apply
      || snapshot.activeReview?.configImpact?.state !== 'known'
      || snapshot.activeReview.configImpact.affectedTargetCount !== 0) return;
    back();
    void beginReview({ ...intent, apply: false });
  }, [route.name, snapshot.activeReview?.reviewToken]);
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
    const inventory = snapshot.projectInventory;
    const plugins = props.controller.listPlugins({ mode: 'browse' });
    const attention = new Set(plugins.filter((entry) => entry.primaryAttention).map((entry) => entry.pluginId)).size;
    const unknown = new Set(plugins.filter((entry) => entry.supportedPlatforms.some((platform) => pluginPlatformUnknown(entry, platform))).map((entry) => entry.pluginId)).size;
    title = '管理  Agent Workflows 插件';
    description = undefined;
    context = undefined;
    const pluginState = [home.pluginUpdateCount ? `↑ ${home.pluginUpdateCount} 可更新` : '',
      attention ? `! ${attention} 需处理` : '', unknown ? `? ${unknown} 未确认` : ''].filter(Boolean).join(' · ') || '✓ 当前可用';
    const projectState = !inventory ? '检查中' : inventory.declarationState === 'notProject' ? '当前不是项目'
      : inventory.declarationState === 'absent' ? '未配置项目插件'
      : inventory.declarationState !== 'ready' ? '! 项目声明需要检查'
      : [inventory.counts.blocked ? `! ${inventory.counts.blocked} 受阻` : '',
          inventory.counts.pending ? `↻ ${inventory.counts.pending} 待同步` : '',
          inventory.counts.unknown ? `? ${inventory.counts.unknown} 未确认` : ''].filter(Boolean).join(' · ') || '✓ 全部就绪';
    const visibleProjectState = snapshot.projectInventoryRefresh.state === 'error'
      ? `! 项目检查失败，显示上次检查结果 · ${projectState}` : projectState;
    const sourceState = [home.catalogUpdateCount ? `↑ ${home.catalogUpdateCount} 有更新` : '',
      home.catalogRecoveryCount ? `! ${home.catalogRecoveryCount} 检查失败` : '',
      home.unavailableSourceCount ? `! ${home.unavailableSourceCount} 不可用` : '',
      home.catalogCheckingCount ? `${home.catalogCheckingCount} 检查中` : ''].filter(Boolean).join(' · ') || '✓ 当前可用';
    actions = [
      { label: '插件', description: pluginState, run: () => go({ name: 'pluginList', mode: 'browse' }) },
      { label: '项目插件', description: visibleProjectState, run: () => go({ name: 'projectStatus' }) },
      { label: '插件来源', description: sourceState, run: () => go({ name: 'sourceList' }) },
    ];
    content = <Box flexDirection="column">{actions.map((action, index) => <Box key={action.label} marginBottom={1}>
      <HomeNavTile width={size.columns - 2} title={action.label} focused={!projectReminderOpen && focus === index}>
        <Text wrap="wrap">{action.description?.split(' · ').map((state, stateIndex) => <Text key={stateIndex}
          color={state.startsWith('↑') ? tuiTheme.roles.change : state.startsWith('!') || state.startsWith('↻') ? tuiTheme.roles.warning
            : state.startsWith('?') ? tuiTheme.roles.unknown : state.startsWith('✓') ? tuiTheme.roles.success : tuiTheme.roles.secondary}>
          {stateIndex > 0 ? ' ' : ''}[{state}]
        </Text>)}</Text>
      </HomeNavTile>
    </Box>)}</Box>;
  } else if (projectFlow) {
    breadcrumb = '项目插件';
    context = undefined;
    const flow = projectFlow;
    if (flow.stage === 'targets') {
      title = '选择本机 Agent';
      description = '选择只保存在本机。保存后可单独同步项目需求。';
      actions = (['codex', 'claude-code', 'cursor'] as const).map((agent): ActionItem => ({
        label: `${flow.agents.includes(agent) ? '✓' : '○'} ${agent}`,
        run: () => setProjectFlow({ ...flow,
          agents: flow.agents.includes(agent)
            ? flow.agents.filter((value) => value !== agent)
            : [...flow.agents, agent].sort(),
        }),
      }));
      actions.push({ label: '查看保存影响', run: () => {
        setProjectAgentsDraft(flow.agents);
        beginProjectTask({ kind: 'targets', action: 'set', agents: flow.agents }, 'targets');
      } });
      actions.push({ label: '重置本机目标与范围覆盖', run: () =>
        beginProjectTask({ kind: 'targets', action: 'reset', agents: [] }, 'targets') });
      actions.push({ label: '返回项目插件', run: closeProjectFlow });
      content = <Box flexDirection="column">
        <SectionCard title="本机 Agent"><StaticRow title={flow.agents.join('、') || '未选择'} compact /></SectionCard>
        <SemanticRows actions={actions} focus={flow.focus} kind="action" compact
          offset={Math.min(Math.max(0, flow.focus - Math.max(1, pageActionBudget(4)) + 1),
            Math.max(0, actions.length - Math.max(1, pageActionBudget(4))))}
          limit={Math.max(1, pageActionBudget(4))} />
      </Box>;
    } else if (flow.stage === 'preparing' || flow.stage === 'progress') {
      title = flow.stage === 'preparing' ? '正在准备项目 Review' : '正在恢复项目插件';
      description = flow.stage === 'preparing'
        ? '正在读取当前证据并准备影响范围。Esc 可取消准备。'
        : '操作已开始。完成后将显示每个目标的结果。';
      content = <Box flexDirection="column"><ProgressRow
        title={flow.stage === 'preparing' ? 'ReviewPreparing' : 'Progress'}
        description={description} state="active" /></Box>;
    } else if (flow.stage === 'review') {
      title = '项目恢复 Review';
      description = '确认完整请求、可执行子集、阻断项和共享影响。';
      readingText = projectPlanText(flow.plan, flow.task);
      actions = [
        { label: flow.plan.kind === 'targets' ? '确认保存本机偏好' : '确认执行可处理目标',
          run: () => executeProjectReview(flow.plan, flow.task) },
        { label: '返回修改', run: () => flow.returnTo === 'targets'
          ? setProjectFlow({ stage: 'targets', agents: projectAgentsDraft, focus: 0 })
          : closeProjectFlow() },
      ];
      content = <Box flexDirection="column"><ReviewCard title="本次影响">
        {readingPage(readingText, size.columns - 6, Math.max(1, pageActionBudget(6)))}
        <SemanticRows actions={actions} focus={flow.focus} kind="action" compact />
      </ReviewCard></Box>;
    } else {
      title = '项目操作 Result';
      description = flow.errorCode ? `操作未完成：${flow.errorCode}`
        : flow.receipt ? flow.receipt.ok ? '项目请求已完成。' : '项目请求仍有未完成目标。'
          : '本机偏好已处理。';
      if (flow.task) description += ' 另一范围仍需独立 Review。';
      readingText = flow.receipt ? projectResultText(flow.receipt, flow.task)
        : flow.errorCode ?? (flow.changed ? '本机偏好已保存。' : '本机偏好没有变化。');
      actions = [
        { label: flow.task ? '返回恢复任务' : '返回项目插件', run: closeProjectFlow },
        ...(flow.task && flow.task.currentScope === 'project'
          && flow.task.targets.some((target) => target.scope === 'user') ? [{
          label: `继续处理所有项目 ${flow.task.targets.filter((target) => target.scope === 'user').length} 个位置`,
          description: '重新准备个人范围并显示独立 Review',
          run: () => {
            closeProjectFlow();
            startSplitTaskScope(flow.task!, 'user');
          },
        }] : []),
        { label: '重新检查项目', run: () => { closeProjectFlow(); void props.controller.refreshProjectInventory(); } },
        ...(flow.receipt?.remainingTargets.length ? [{ label: `仅重试未完成目标（${flow.receipt.remainingTargets.length}）`,
          run: () => beginProjectTask({ kind: 'recovery',
            command: flow.receipt!.command as 'sync' | 'install' | 'reinstall' | 'uninstall' | 'cleanup',
            selectors: [...new Set(flow.receipt!.remainingTargets.map((target) => target.pluginId))],
            exactTargets: flow.receipt!.remainingTargets,
          }) }] : []),
      ];
      content = <Box flexDirection="column"><ResultCard
        status={flow.errorCode || flow.receipt && !flow.receipt.ok ? 'warning' : 'success'}
        title={description}>
        {readingPage(readingText, size.columns - 6, Math.max(1, pageActionBudget(6)))}
        <SemanticRows actions={actions} focus={flow.focus} kind="action" compact />
      </ResultCard></Box>;
    }
  } else if (route.name === 'projectStatus') {
    const inventory = snapshot.projectInventory;
    const recovery = inventory?.recovery;
    const section = snapshot.router.current.context.projectSection ?? 'declared';
    const statusFilter = snapshot.router.current.context.projectStatusFilter ?? 'all';
    const stateLabel = { blocked: '受阻', pending: '待同步', unknown: '未确认', ready: '就绪' };
    const searchedRoots = props.controller.listProjectInventoryRoots(section).filter((root) =>
      queryMatches(query, root.displayName, root.pluginId, root.sourceId));
    const roots = searchedRoots.filter((root) => statusFilter === 'all' || root.state === statusFilter);
    const statusCounts = Object.fromEntries(PROJECT_STATUS_FILTERS.map((filter) => [filter,
      filter === 'all' ? searchedRoots.length : searchedRoots.filter((root) => root.state === filter).length,
    ])) as Record<ProjectStatusFilter, number>;
    toggleProjectStatusFilter = () => {
      const available = PROJECT_STATUS_FILTERS.filter((filter) =>
        filter === 'all' || filter === statusFilter || statusCounts[filter] > 0);
      const next = available[(available.indexOf(statusFilter) + 1) % available.length]!;
      props.controller.updatePageContext({ projectStatusFilter: next });
      dynamicMenuFocus.current = undefined;
      actionJumpAnchor.current = undefined;
      setFocus(0);
      setScrollOffset(0);
    };
    moveProjectSection = () => {
      const next = section === 'declared' ? 'extraInstalled' : 'declared';
      props.controller.updatePageContext({ projectSection: next });
      dynamicMenuFocus.current = undefined;
      actionJumpAnchor.current = undefined;
      setFocus(0);
      setScrollOffset(0);
    };
    breadcrumb = '项目插件';
    title = showTechnical ? '项目状态安全详情' : inventory?.projectName ?? '项目插件';
    context = undefined;
    description = snapshot.projectInventoryRefresh.state === 'error'
      ? '项目检查失败；以下显示上次检查结果。可重新检查。'
      : inventory?.declarationState === 'notProject' ? '当前不是项目；没有项目同步目标。'
      : inventory?.declarationState === 'absent' ? '未配置项目插件。'
        : inventory?.declarationState === 'invalid' || inventory?.declarationState === 'unavailable' ? '项目声明需要检查。' : undefined;
    if (recovery && snapshot.projectInventoryRefresh.state !== 'error') {
      description = `本机 Agent：${recovery.selection.agents.join('、') || '未选择'} · ${
        recovery.selection.origin === 'preference' ? '本机偏好' : recovery.selection.origin === 'argument'
          ? '一次性参数' : '请先选择'}`;
    }
    actions = roots.map((root) => ({
      actionId: `project-root:${root.pluginId}`, pluginId: root.pluginId,
      label: root.displayName,
      run: () => go({ name: 'pluginDetail', pluginId: root.pluginId }),
    }));
    const syncTargets = inventory?.syncTargets ?? [];
    const syncCount = new Set(syncTargets.map((target) => target.pluginId)).size;
    const projectRestoreIds = recovery ? [] : [...new Set(props.controller.listPluginWriteTaskCandidates('restore')
      .filter((candidate) => candidate.target.scope === 'project')
      .map((candidate) => candidate.target.pluginId))];
    const removedRoots = recovery?.inventory?.filter((root) => root.sourceState === 'ready'
      && root.blockers.some((blocker) => blocker.code === 'pluginUnavailable')) ?? [];
    bottomActions = [
      ...(inventory?.projectRoot && recovery ? [{ actionId: 'project-targets',
        label: '设置本机 Agent', status: 'info' as const,
        run: () => {
          projectPageAnchor.current = batchTargetOffset;
          const agents = [...recovery.selection.agents];
          setProjectAgentsDraft(agents);
          setProjectFlow({ stage: 'targets', agents, focus: 0 });
        } },
      ...(recovery.inventory && recovery.inventory.length > 0 ? [{ actionId: 'project-sync-actionable',
        label: `同步全部项目需求（${recovery.inventory.length}） [c]`, status: 'info' as const,
        run: () => beginProjectTask({ kind: 'recovery', selectors: [] }) }] : []),
      ] : []),
      ...removedRoots.map((root): ActionItem => ({
        actionId: `project-cleanup-removed:${root.pluginId}`,
        label: `整体清理已删除插件 ${root.pluginId}`,
        status: 'warning',
        run: () => beginProjectTask({ kind: 'recovery', command: 'cleanup', selectors: [root.pluginId] }),
      })),
      ...(!recovery && inventory?.projectRoot && syncCount > 0 ? [{ actionId: 'project-sync-actionable',
        label: `同步全部可处理声明（${syncCount}） [c]`, status: 'info' as const,
        run: () => prepareCurrentProjectTargets(syncTargets) }] : []),
      ...(projectRestoreIds.length > 0 ? [{ actionId: 'project-restore',
        label: `修复当前项目（${projectRestoreIds.length}）`,
        run: () => openSelectedPluginTask('restore', projectRestoreIds, 'project') }] : []),
      ...((): ActionItem[] => {
        const issues = props.controller.listUserIssues().filter((issue) =>
          props.controller.listProjectInventoryRoots('declared').some((root) =>
            issueMatchesTarget(issue, root.pluginId)));
        if (issues.length === 0) return [];
        const focusedRoot = roots[focus];
        const selectedIssue = focusedRoot
          ? issues.find((issue) => issueMatchesTarget(issue, focusedRoot.pluginId)) : undefined;
        const issue = selectedIssue ?? (issues.length === 1 ? issues[0] : undefined);
        return [{ actionId: 'project-open-issues',
          label: issue ? '查看对应问题' : '查看需要处理',
          run: () => go(issue
            ? { name: 'issueDetail', issueId: issue.issueId } : { name: 'issueList' }) }];
      })(),
      ...(!showTechnical && (inventory?.counts.blocked || inventory?.counts.unknown || snapshot.projectIntentIssue
        || recovery?.errors.length) ? [{ actionId: 'project-error-details', label: '错误详情', run: toggleTechnical }] : []),
      { actionId: 'project-recheck', label: snapshot.projectInventoryRefresh.state === 'checking' ? '正在检查项目' : '重新检查项目 [r]',
        disabled: snapshot.projectInventoryRefresh.state === 'checking' ? '检查中' : undefined,
        run: async () => { await props.controller.refreshProjectInventory(); } },
    ];
    const technicalText = [snapshot.projectIntentIssue ? `${safeDiagnosticCode(snapshot.projectIntentIssue.code, 'projectIntentUnknown')} · ${sanitizeDiagnosticText(snapshot.projectIntentIssue.message)}` : '',
      ...(recovery?.errors.map((error) => `${error.code} · ${error.message}`) ?? []),
      ...(recovery?.inventory?.flatMap((root) => [
        ...root.blockers.map((blocker) => `${root.pluginId} · ${blocker.code} · ${blocker.message}`),
        ...root.targetResults.flatMap((target) => target.blockers.map((blocker) =>
          `${root.pluginId} · ${target.agent} · ${blocker.code} · ${blocker.message}`)),
      ]) ?? []),
      ...props.controller.listProjectInventoryRoots(section).flatMap((root) => [...projectDependencyLines(root), ...root.targets.flatMap((target) => [
        `${root.pluginId} · ${platformLabel(target.platform)} · ${scopeLabel(target.scope)}`,
        `目录参考 ${target.expectedVersion ?? '未知'} · 实际 ${target.installedVersion ?? '未知'} · ${stateLabel[target.state]}`,
        ...target.reasonCodes.map((code) => `原因 · ${safeDiagnosticCode(code, 'projectTargetUnknown')}`)])])].filter(Boolean).join('\n');
    const itemCount = showTechnical ? 0 : actions.length;
    actions = [...(showTechnical ? [] : actions), ...bottomActions];
    dynamicActionIds = actions.map((action) => action.actionId!);
    dynamicActionSignature = dynamicActionIds.join('\0');
    const previousProjectFocus = dynamicMenuFocus.current;
    if (previousProjectFocus?.routeKey === routeKey
      && previousProjectFocus.actionIds !== dynamicActionSignature) {
      const retained = previousProjectFocus.focusedActionId
        ? dynamicActionIds.indexOf(previousProjectFocus.focusedActionId) : -1;
      effectiveFocus = retained >= 0 ? retained
        : itemCount > 0 ? 0 : dynamicActionIds.indexOf('project-recheck');
    }
    help = recovery
      ? '↑↓ 移动 · Enter 查看 · s 同步所选 · c 同步全部 · x 清理已删除 · t 设置 Agent · Esc 返回'
      : '↑↓ 移动 · Enter 查看 · Esc 返回';
    if (showTechnical) {
      readingText = technicalText;
      content = <Box flexDirection="column">
        {readingPage(technicalText, size.columns - 2, Math.max(1, pageActionBudget(4) - 1))}
        <SemanticRows actions={actions} focus={effectiveFocus} kind="action" compact /></Box>;
    } else {
      const cardWidth = size.columns - 2;
      const lineLimit = Math.max(1, Math.min(3, pageActionBudget(3) - 4));
      const cardSubjects = roots.map((root) => props.controller.getPluginDetailSubject(root.pluginId)!);
      const cardLayouts = roots.map((root, index) => projectRootCardLayout(root, cardSubjects[index]!, cardWidth));
      entityCardNavigation = { itemCount, factRows: cardLayouts.map((card) => card.factRows), lineLimit };
      const emptyHint = roots.length === 0 && inventory?.declarationState === 'ready'
        && Boolean(searchedRoots.length > 0 || query || statusFilter !== 'all');
      const projectViewport = rowViewport({
        rowHeights: [...cardLayouts.map((card, index) => entityCardWindowHeight(card,
          index === effectiveFocus ? batchTargetOffset : 0, lineLimit)), ...bottomActions.map(() => 1)],
        focus: effectiveFocus, requestedOffset: scrollOffset,
        rowBudget: pageActionBudget(3 + Number(emptyHint)),
      });
      content = <Box flexDirection="column">
      {recovery ? <StaticRow title={`本机 Agent：${recovery.selection.agents.join('、') || '未选择'}`}
        description={recovery.selection.agents.length === 0 ? '设置本机 Agent 后可恢复项目需求。' : undefined}
        status={recovery.selection.agents.length === 0 ? 'warning' : 'info'} compact /> : null}
      <QueryHeader width={size.columns - 2}
        tabs={{ items: [
          { id: 'declared', label: '项目声明', count: props.controller.listProjectInventoryRoots('declared').filter((root) => queryMatches(query, root.displayName, root.pluginId, root.sourceId)).length },
          { id: 'extraInstalled', label: '额外安装', count: props.controller.listProjectInventoryRoots('extraInstalled').filter((root) => queryMatches(query, root.displayName, root.pluginId, root.sourceId)).length },
        ], currentId: section }}
        search={{ value: query, placeholder: '名称或来源', input: searchFocus
          ? <InputDisplay value={query} cursor={searchCursor} columns={querySearchWidth(size.columns - 2)} /> : undefined }}
        filter={{ label: PROJECT_STATUS_LABELS[statusFilter], count: statusCounts[statusFilter],
          currentZero: statusCounts[statusFilter] === 0 && statusFilter !== 'all' }} />
      {emptyHint
        ? <Text color={tuiTheme.roles.secondary}>当前条件无匹配；搜索和筛选保持原样。</Text> : null}
      <ContentViewport>{actions.slice(projectViewport.offset, projectViewport.offset + projectViewport.limit)
        .map((action, visibleIndex) => {
          const index = projectViewport.offset + visibleIndex;
          if (index >= itemCount) return <SemanticRows key={action.actionId} actions={actions}
            focus={searchFocus ? -1 : effectiveFocus} kind="action" compact offset={index} limit={1} />;
          return <ProjectRootCard key={action.actionId} root={roots[index]!}
            subject={cardSubjects[index]!} width={cardWidth} focused={!searchFocus && effectiveFocus === index}
            lineOffset={effectiveFocus === index ? batchTargetOffset : 0} lineLimit={lineLimit} />;
        })}</ContentViewport>
    </Box>;
    }
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
    const sourceTabs = [{ id: 'all', label: '全部', count: props.controller.listPlugins({
      mode: route.mode, ...(query ? { query } : {}), installFilter,
    }).length }, ...props.controller.listSources().map((source) => ({
      id: source.id, label: source.label,
      count: props.controller.listPlugins({ mode: route.mode, sourceId: source.id,
        ...(query ? { query } : {}), installFilter }).length,
    }))];
    breadcrumb = '插件';
    title = `插件 · ${items.length} 个`;
    description = undefined;
    context = `${items.length} 个插件`;
    help = '↑↓ 移动 · Enter 查看 · Esc 返回';
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
      setFocus(retained >= 0 ? retained : Math.min(focus, Math.max(0, nextRowIds.length - 1)));
      setScrollOffset(0);
    };
    const availableFilters = PLUGIN_FILTERS.filter((filter) => filter === 'all' || filterCounts[filter] > 0 || filter === installFilter);
    togglePluginListFilter = () => {
      const nextFilter = availableFilters[(availableFilters.indexOf(installFilter) + 1)
        % availableFilters.length]!;
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
        : Math.min(focus, Math.max(0, nextRowIds.length - 1));
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
    const menuActions: ActionItem[] = [
      ...(props.controller.listUserIssues().length > 0 ? [{ actionId: 'plugin-list-issues',
        label: '需要处理', run: () => go({ name: 'issueList' }) }] : []),
      ...(recommendedUpdatePluginIds.length > 0 ? [{
        actionId: 'plugin-list-update',
        label: `更新 ${recommendedUpdatePluginIds.length} 个`,
        description: '使用已验证版本和现有安装位置，直接查看任务确认',
        status: 'info' as const,
        run: () => openRecommendedUpdateTask(recommendedUpdatePluginIds),
      }] : []),
      {
        actionId: 'plugin-list-multi',
        label: '选择多个插件 [m]',
        description: '先选择插件，再选择安装、更新、恢复、卸载或维护任务',
        run: () => openBatchSelection(),
      },
    ];
    const searchAction: ActionItem = {
      actionId: 'plugin-list-search', label: '搜索 [/]',
      run: () => { setSearchCursor([...new Intl.Segmenter(undefined, { granularity: 'grapheme' })
        .segment(query)].length); setSearchFocus(true); },
    };
    const filterAction: ActionItem = {
      actionId: 'plugin-list-filter', label: '切换筛选 [f]', run: togglePluginListFilter,
    };
    listQueryActions = [searchAction, filterAction];
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
    if (installFilter !== 'all' && items.length === 0 && !sourceError) {
      title = '本条件无匹配';
      description = '保留当前筛选；可切换筛选或修改搜索。';
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
    bottomActions = dedupeActions([
      ...(sourceError ? actions : []),
      ...actions,
      ...menuActions,
    ]);
    actions = [...pluginRows.map((row) => ({
      actionId: `plugin:${row.pluginId}`, pluginId: row.pluginId, label: row.name,
      run: () => go({ name: 'pluginDetail', pluginId: row.pluginId }),
    })), ...bottomActions];
    const viewport = rowViewport({
      rowHeights: actions.map((_, index) => index < pluginRows.length
        ? pluginListRowLayout({
            ...pluginRows[index]!, width: size.columns - 2,
            hasTags: Boolean(pluginRows[index]!.tags),
          }).height : 1),
      focus, requestedOffset: scrollOffset, rowBudget: pageActionBudget(3),
    });
    content = (
      <Box flexDirection="column">
        <QueryHeader width={size.columns - 2}
          tabs={{ label: '来源', items: sourceTabs, currentId: sourceId }}
          search={{ value: query, placeholder: '名称或用途', input: searchFocus
            ? <InputDisplay value={query} cursor={searchCursor} placeholder="输入搜索内容" columns={querySearchWidth(size.columns - 2)} /> : undefined }}
          filter={{ label: pluginFilterLabel(installFilter), count: filterCounts[installFilter],
            currentZero: installFilter !== 'all' && filterCounts[installFilter] === 0 }} />
        {sourceError
          ? <Callout status="error" title={`${sourceId} 暂时无法提供插件`} description="当前不能浏览这个来源。" />
          : route.mode === 'installed' && items.length === 0 && !query && sourceId === 'all'
            ? installFilter === 'updateAvailable'
              ? <Callout title="没有可更新插件" description="当前筛选范围内没有经过版本证据确认的更新。" />
              : <Callout title="开始添加第一个插件" description="插件可以安装到 Codex、Claude Code 或两者。" />
            : null}
        <ContentViewport>
          <PluginRows columns={size.columns - 2} rows={pluginRows} focus={focus} viewport={viewport} active={!searchFocus} />
          <SemanticRows actions={actions} focus={searchFocus ? -1 : focus} kind="action" compact
            offset={Math.max(pluginRows.length, viewport.offset)}
            limit={Math.max(0, viewport.offset + viewport.limit - Math.max(pluginRows.length, viewport.offset))} />
        </ContentViewport>
      </Box>
    );
  } else if (route.name === 'batchSelection') {
    breadcrumb = '插件 / 选择多个';
    title = batchDraft?.stage === 'task' ? `为 ${batchDraft.selectedPluginIds.length} 个插件选择任务`
      : batchDraft?.stage === 'maintenance' ? '其他维护方式'
        : '选择插件';
    description = batchDraft?.stage === 'select'
      ? undefined
      : batchDraft?.stage === 'task'
        ? '更新和恢复沿用已经添加的位置；移除会逐项显示已有位置。'
        : '同步、重新安装和普通清理使用所选插件的已有位置。';
    if (!batchDraft) {
      actions = [{ role: 'navigation' as const, label: '返回插件列表', run: back }];
      content = <SemanticRows actions={actions} focus={focus} kind="action" compact />;
    } else if (batchDraft.stage === 'select') {
      const candidates = batchCandidates(batchDraft);
      const selected = new Set(batchDraft.selectedPluginIds);
      const currentIds = new Set(candidates.map((candidate) => candidate.pluginId));
      const hiddenSelected = batchDraft.selectedPluginIds.filter((pluginId) => !currentIds.has(pluginId)).length;
      const batchSearchDraft = { ...batchDraft, showSelected: false };
      const batchFilterCounts = Object.fromEntries(PLUGIN_FILTERS.map((filter) => [filter,
        batchCandidates({ ...batchSearchDraft, installFilter: filter }).length,
      ])) as Record<PluginInstallFilter, number>;
      const batchSourceTabs = [{ id: 'all', label: '全部', count: batchCandidates({ ...batchSearchDraft,
        sourceId: undefined }).length }, ...props.controller.listSources().map((source) => ({
        id: source.id, label: source.label,
        count: batchCandidates({ ...batchSearchDraft, sourceId: source.id }).length,
      }))];
      const candidateActions: ActionItem[] = candidates.map((candidate) => {
        const blockReason = batchCandidateBlockReason(batchDraft, candidate);
        const isSelected = selected.has(candidate.pluginId);
        const plugin = candidate.plugin;
        return {
          actionId: `batch:${candidate.pluginId}`,
          label: plugin
            ? plugin.displayName
            : `${candidate.pluginId}（已不可用，可取消选择）`,
          sourceLabel: plugin?.sourceLabel,
          maxDescriptionRows: 2,
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
      const continueLabel = batchDraft.recommendedGoal === 'update' ? '查看升级汇总'
        : batchDraft.recommendedGoal ? '查看恢复汇总' : '继续选择任务';
      const continueAction: ActionItem = {
        actionId: 'batch-selection-continue',
        label: `${continueLabel}（${batchDraft.selectedPluginIds.length}） [c]`,
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

        },
      };
      const selectionToolActions: ActionItem[] = [
        {
          role: 'navigation', label: '返回插件选择',
          description: '保留当前已选插件',
          run: closeBatchSelectionTools,
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
          if (batchDraft.showSelectionTools) {
            closeBatchSelectionTools();
            return;
          }
          setBatchDraft((current) => current ? { ...current, showSelectionTools: true } : current);
          setFocus(0);
          setScrollOffset(0);
        },
      };
      bottomActions = [continueAction, selectedSetAction, selectionToolsAction];
      actions = [...(batchDraft.showSelectionTools ? selectionToolActions : candidateActions), ...bottomActions];
      const batchFocus = Math.min(focus, Math.max(0, actions.length - 1));
      context = `已选 ${batchDraft.selectedPluginIds.length} 个 · 显示 ${candidates.length} 个${hiddenSelected > 0 ? ` · 隐藏 ${hiddenSelected} 个` : ''}`;
      help = batchDraft.showSelectionTools
        ? '↑↓ 移动 · Enter 执行 · Esc 返回选择'
        : '↑↓ 移动 · Space 选择 · Enter 查看 · Esc 返回';
      content = <Box flexDirection="column">
        <QueryHeader width={size.columns - 2}
          tabs={{ label: '来源', items: batchSourceTabs,
            currentId: batchDraft.showSelected ? 'all' : batchDraft.sourceId ?? 'all' }}
          search={{ value: batchDraft.query, placeholder: '名称或用途', input: searchFocus
            ? <InputDisplay value={batchDraft.query} cursor={searchCursor} placeholder="输入搜索内容" columns={querySearchWidth(size.columns - 2)} /> : undefined }}
          filter={{ label: pluginFilterLabel(batchDraft.installFilter), count: batchFilterCounts[batchDraft.installFilter],
            currentZero: batchDraft.installFilter !== 'all' && batchFilterCounts[batchDraft.installFilter] === 0 }}
          selection={{ total: selected.size, hidden: hiddenSelected }} />
        <SequenceRows actions={actions} itemCount={batchDraft.showSelectionTools ? 0 : candidateActions.length}
          focus={batchFocus} scrollOffset={scrollOffset} columns={size.columns - 2}
          rowBudget={pageActionBudget(4)} compact={policy.mode === 'compact'} cards inactive={searchFocus} />
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
          { label: '同步已保存使用设置', status: 'info', description: `重新应用 ${syncTargets.length} 个已保存或现场目标`, run: () => startExistingBatch('sync') },
          { label: '重新安装', status: 'info', description: `重新生成 ${props.controller.listPluginWriteBatchTargets('reinstall', selectedIds).length} 个已保存或现场目标`, run: () => startExistingBatch('reinstall') },
          { label: '清理遗留内容', status: 'error', description: `${props.controller.listPluginWriteBatchTargets('cleanup', selectedIds).length} 个已核验位置；保留不属于插件或被共用的内容`, run: () => startExistingBatch('cleanup') },
          {
            role: 'navigation' as const, label: '返回任务选择',
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
            status: 'info' as const,
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
          { role: 'navigation', label: '返回调整选择', run: () => moveBatchStage('select') },
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
      label: '确定所选平台 [c]',
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
    bottomActions = [confirmPlatforms];
    help = '↑↓ 移动 · Space/Enter 切换 · c 确定所选平台 · Esc 返回任务选择';
    content = <Box flexDirection="column">
      <ContentViewport>
        <SemanticRows actions={actions.slice(0, 2)} focus={focus}
          kind="choice" compact={policy.mode === 'compact'} />
        <SemanticRows actions={actions} focus={focus}
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
      actions = [{ role: 'navigation' as const, label: '返回批量选择', run: back }];
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
        { role: 'navigation' as const, label: '返回任务选择', run: back },
      ];
      bottomActions = [confirmMaintenance];
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
        if (confirmPlacement) bottomActions = [confirmPlacement];
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
            role: 'navigation' as const, label: '返回位置选择',
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
        ? '↑↓ 移动 · Enter 选择· c 查看确认 · Esc 返回修改'
        : '↑↓ 移动 · Enter 选择 · Esc 返回修改';
    const placementDetail = Boolean(batchDraft?.showPlacementTargets);
    const viewport = actionViewport(
      actions,
      placementDetail ? false : policy.mode === 'compact',
      focus,
      scrollOffset,
      pageActionBudget(maintenanceMode ? 4 : 1),
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
              focus={focus - groupOffset} kind={group.kind}
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
    description = undefined;
    const visibleCandidates = portableSelectionView === 'selected'
      ? portableVisibleCandidates.filter((candidate) => candidate.selected)
      : portableVisibleCandidates;
    const hiddenSelected = draft.candidates.filter((candidate) => candidate.selected
      && !visibleCandidates.includes(candidate)).length;
    const continuePortableSelection = (): void => {
      if (!draft.canContinue) {
        setPortableEmptySelectionOpen(true);
        return;
      }
      go({ name: 'portableAgentMode', pluginId: plugin.pluginId });
    };
    const candidateActions: ActionItem[] = visibleCandidates.map((candidate) => ({
      actionId: `skill:${candidate.providerPluginId}:${candidate.name}`,
      label: draft.candidates.filter((entry) => entry.name === candidate.name).length > 1
        ? `${candidate.name} · ${candidate.providerDisplayName}` : candidate.name,
      selected: candidate.selected,
      description: candidate.shortDescription ?? candidate.description.split(/[。！？\n]/u)[0]?.slice(0, 160),
      exception: candidate.availableScopes.length === 0 ? '安装范围待确认'
        : portableScopeVariantsDiffer(candidate) ? '范围内容不同，继续后确认'
          : candidate.availableScopes.length === 1 ? `仅${scopeLabel(candidate.availableScopes[0]!)}` : undefined,
      run: () => props.controller.togglePortableSkill(candidate.name),
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
      { role: 'navigation', actionId: 'portable-selection-tools-back', label: '返回 Skills 列表', run: () => {
        setPortableToolsOpen(false);
        setFocus(0);
        setScrollOffset(0);
      } },
    ];
    const continueAction: ActionItem = { actionId: 'portable-selection-continue', label: `继续（${draft.selectedCount}） [c]`, run: continuePortableSelection };
    const openToolsAction: ActionItem = { actionId: 'portable-selection-tools', label: '选择工具', run: () => {
      setPortableToolsOpen(true);

      setFocus(0);
      setScrollOffset(0);
    } };
    bottomActions = [continueAction, openToolsAction];
    actions = portableToolsOpen ? selectionToolActions : [...candidateActions, ...bottomActions];
    const visibleCandidateEntries = visibleCandidates.map((candidate, index) => ({ candidate, index }));
    const variantCandidates = portableVariantCandidates;
    const focusedVariant = variantCandidates.find((candidate) => candidate.name === visibleCandidates[focus]?.name);
    const visibleVariant = visibleCandidateEntries.find((entry) => portableScopeVariantsDiffer(entry.candidate))?.candidate;
    const technicalVariant = focusedVariant ?? visibleVariant ?? variantCandidates[0];
    help = portableToolsOpen ? '↑↓ 移动 · Enter 选择 · Esc 返回'
      : '↑↓ 移动 · Space/Enter 切换 · Esc 返回';
    content = <Box flexDirection="column">
      <QueryHeader width={size.columns - 2}
        search={{ value: query, placeholder: '名称或短描述', input: searchFocus
          ? <InputDisplay value={query} cursor={searchCursor} columns={querySearchWidth(size.columns - 2)} /> : undefined }}
        selection={{ total: draft.selectedCount, hidden: hiddenSelected }} />
      <ContentViewport>
      <SequenceRows actions={actions} itemCount={portableToolsOpen ? 0 : candidateActions.length}
        focus={focus} scrollOffset={scrollOffset} columns={size.columns - 2}
        rowBudget={pageActionBudget(2 + (variantCandidates.length > 0 ? 3 : 0) + (!draft.canContinue ? 1 : 0)
          + (showTechnical && technicalVariant ? 5 : 0))}
        compact={policy.mode === 'compact'} skillRows inactive={portableEmptySelectionOpen} />
      {!portableToolsOpen && variantCandidates.length > 0
        ? showTechnical
          ? <StaticRow title={`! ${variantCandidates.length} 个 Skill 存在范围变体`} status="warning" compact />
          : <Callout status="warning" title={`! ${variantCandidates.length} 个 Skill 在不同安装范围会生成不同内容。选择范围后会重新确认最终内容。`} />
        : null}
      {!portableToolsOpen && visibleCandidates.length === 0
        ? <StaticRow title={query ? '当前搜索没有匹配 Skill'
          : portableSelectionView === 'selected' ? '没有已选 Skill' : '当前没有可选 Skill'}
          description={query ? '清除搜索后可查看其他候选' : '选择“查看全部候选”后可继续勾选'} status="muted" compact />
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
  } else if (route.name === 'portablePreparing' && plugin) {
    breadcrumb = `${plugin.displayName} / 通用 Skills`;
    context = '只读检查';
    title = '正在准备可安装的 Skills';
    description = '正在检查当前项目和所有项目范围的完整依赖。此步骤不会写入文件或调用 Skills CLI。';
    content = <Box flexDirection="column">
      <StatusCard status="info" title="准备候选">
        <StaticRow title="● 检查当前项目范围" compact />
        <StaticRow title="● 检查所有项目范围" compact />
        <StaticRow title="○ 合并可选 Skill 与 Agent 信息" status="muted" compact />
      </StatusCard>
    </Box>;
    help = 'Esc 取消检查并返回目标平台';
  } else if (route.name === 'portableDependencies' && plugin && snapshot.portableDraft) {
    breadcrumb = `${plugin.displayName} / 通用 Skills / 依赖`;
    context = `${snapshot.portableDraft.selectedCount} 个 Skills`;
    title = '本次生成依赖';
    description = '关系图显示已知依赖；所选 Skills 和安装位置仍以最终汇总为准。';
    renderDependencyGraph(plugin.pluginId, true);
  } else if (route.name === 'portableAgentMode' && plugin && snapshot.portableDraft) {
    breadcrumb = `${plugin.displayName} / 通用 Skills / Agent`;
    title = '安装到哪些 Agent？';
    description = '可以自动选择检测到的 Agent，也可以限制到指定 Agent。';
    actions = [
      { label: '自动选择可用 Agent', description: '按当前环境确定可用 Agent，不承诺全部 Agent 可用', meta: '默认', selected: snapshot.portableDraft.agentMode === 'automatic', run: () => { props.controller.setPortableAgentMode('automatic'); go({ name: 'portableScope', pluginId: plugin.pluginId }); } },
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
      ...(route.operationRecordId ? [{
        label: '查看诊断与报告',
        description: `安全记录 ${route.operationRecordId}`,
        run: () => go({ name: 'operationDiagnostic', recordId: route.operationRecordId! }),
      }] : []),
      { label: snapshot.installPlacementDraft?.pluginId === plugin.pluginId ? '返回目标平台' : '返回插件详情', run: () => props.controller.resetPortableFlowToPreview(plugin.pluginId) },
      ...(cliUnavailable
        ? []
        : [{ label: showTechnical ? '返回问题摘要' : '技术详情', run: () => toggleTechnical() }]),
    ];
    const technicalPageRows = responsiveBudget(2, 4);
    if (showTechnical && !showPortableRequirements) {
      readingText = diagnosticDetailText(diagnostic);
      referenceDetailPagination = {
        total: diagnosticDetailLines(diagnostic, size.columns - 6).length,
        pageRows: technicalPageRows,
      };
      help = '←→ 或 PgUp/PgDn 阅读技术字段 · ↑↓ 移动 · Enter 选择 · Esc 返回';
    }
    const blockerActionViewport = actionViewport(actions, policy.mode === 'compact', focus, scrollOffset, responsiveBudget(2, 4));
    content = <Box flexDirection="column">
      {showPortableRequirements ? <>
        <StaticRow title="在 PATH 中提供兼容的 skills 可执行文件。" compact />
        <StaticRow title={`当前 AW adapter 支持：${SKILLS_CLI_SUPPORTED_VERSION_LABEL}`} compact />
        <StaticRow title="准备完成后返回问题摘要并重新检查。" compact />
        <StaticRow title="不会自动运行 npx latest、sudo 或在线安装脚本。" status="warning" compact />
        <StaticRow title="选定插件、安装目标和 Portable 草稿保持不变。" status="success" compact />
        <StaticRow title="AW 不会在此页安装外部依赖。" status="warning" compact />
      </> : <DiagnosticSummary diagnostic={diagnostic} technical={showTechnical} columns={size.columns}
        offset={showTechnical ? batchTargetOffset : undefined}
        limit={showTechnical ? technicalPageRows : undefined} compact={policy.mode === 'compact'} />}
      <SemanticRows actions={actions} focus={focus} kind="action" compact={policy.mode === 'compact'} offset={blockerActionViewport.offset} limit={blockerActionViewport.limit} />
    </Box>;
  } else if (route.name === 'pluginDependencies' && !plugin
    && route.view !== 'removeBlocked' && props.controller.getPluginDetailSubject(route.pluginId)) {
    const subject = props.controller.getPluginDetailSubject(route.pluginId)!;
    breadcrumb = `${subject.displayName} / 依赖关系`;
    title = '已知依赖关系';
    description = 'A → B 表示 A 需要 B；未验证关系不表示当前可用。';
    context = subject.relations.checkState === 'checked' ? '已检查' : '部分未确认';
    renderDependencyGraph(route.pluginId, false);
  } else if (route.name === 'pluginDependencies' && plugin) {
    const overview = dependencyOverview(plugin);
    const visibleDependents = route.view === 'removeBlocked' && route.platform && route.scope
      ? props.controller.getBlockingDependents(plugin.pluginId, route.platform, route.scope)
      : overview?.dependents ?? [];
    const dependentCount = visibleDependents.length;
    const dependentLimit = responsiveBudget(1, 3);
    const dependencyRows = (entries: PluginDependencyItemViewModel[], limit: number, dependent = false): React.ReactNode => {
      const page = pagedItems(entries.length, limit);
      const visible = entries.slice(page.offset, page.offset + limit);
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
        {page.pageCount > 1 ? <Pager page={page.page} pageCount={page.pageCount} columns={size.columns - 4} /> : null}
      </>;
    };
    if (route.view === 'removeBlocked') {
      if (!showTechnical) readingText = visibleDependents.map((entry) =>
        `${entry.displayName} · ${dependencyRelationDescription(entry)} · ${dependentTargetLabel(entry)}`).join('\n');
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
        { role: 'navigation' as const, label: '返回插件详情', run: back },
        { label: showTechnical ? '隐藏技术详情' : '技术详情', run: () => toggleTechnical() },
      ];
      actions = blockedRemovalActions;
      if (!showTechnical && visibleDependents.length > dependentLimit) {
        referenceDetailPagination = { total: visibleDependents.length, pageRows: dependentLimit };
      }
      const blockedRemovalViewport = actionViewport(actions, policy.mode === 'compact', focus, scrollOffset, pageActionBudget(5));
      if (!showTechnical && visibleDependents.length > dependentLimit) {
        help = '←→ 查看全部被依赖关系 · ↑↓ 移动 · Enter 选择 · Esc 返回';
      }
      content = <Box flexDirection="column">
        <StaticRow title={`${dependentCount} 个已安装插件仍在使用`} status="error" compact />
        <StaticRow title="没有修改任何安装。" status="muted" compact />
        {showTechnical ? null : <>
          <StaticRow title="使用这个依赖的插件" meta="反向引用" compact />
          {dependencyRows(visibleDependents, dependentLimit, true)}
        </>}
        <SemanticRows actions={actions} focus={focus} kind="action" compact={policy.mode === 'compact'} offset={blockedRemovalViewport.offset} limit={blockedRemovalViewport.limit} />
        {showTechnical ? <IssueTechnicalDetails details={[{
          code: 'dependencyStillRequired',
          message: '已安装插件仍在使用这个依赖；请先处理依赖者。',
        }]} compact={policy.mode === 'compact'} /> : null}
      </Box>;
    } else {
      breadcrumb = `${plugin.displayName} / 依赖关系`;
      context = '上下游';
      title = hasInstalledPlacement(plugin) ? '依赖与当前可用关系' : '安装所需插件';
      description = 'A → B 表示 A 需要 B；实线已验证，虚线未验证。';
      renderDependencyGraph(plugin.pluginId, false);
    }
  } else if (route.name === 'pluginDependencyNode' && route.view === 'references'
    && props.controller.getPluginDetailSubject(route.pluginId)) {
    const root = props.controller.getPluginDetailSubject(route.pluginId)!;
    const node = props.controller.getPluginDetailSubject(route.nodePluginId);
    const nodeProjection = buildDependencyGraphProjection({
      overviews: props.controller.listPluginDependencyOverviews(),
      rootPluginId: route.pluginId,
      direction: route.direction,
      expandedPluginIds: route.nodePathPluginIds ?? [route.pluginId, route.nodePluginId],
      focusPluginId: route.nodePluginId,
    });
    const selectedRow = nodeProjection.rows.find((row) =>
      row.pathPluginIds.join('\0') === route.nodePathPluginIds?.join('\0'))
      ?? nodeProjection.rows.find((row) => row.pluginId === route.nodePluginId);
    const references = selectedRow?.edge?.availablePlacementReferences ?? [];
    breadcrumb = `${root.displayName} / 依赖关系 / ${node?.displayName ?? route.nodePluginId} / 引用`;
    context = '完整引用';
    title = `当前可用依赖位置 ${references.length} 个`;
    description = references.length > 0
      ? '这些位置在本次检查中已验证；其他项目未检查。'
      : '本次没有可验证的位置引用；声明关系不表示当前可用。';
    readingText = selectedRow
      ? dependencyEvidenceLines(selectedRow, node).join('\n')
      : `pluginId · ${route.nodePluginId}\n目录版本 · ${node?.catalogVersion ?? '未确认'}\nrelationship · unknown\n连续路径 · 未验证`;
    content = <Box flexDirection="column">
      {readingPage(readingText, size.columns - 2, pageActionBudget(2))}
    </Box>;
    help = '←→/PgUp/PgDn 翻页 · y 复制全文 · Esc 返回';
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
        { role: 'navigation' as const, label: '返回插件详情', run: back },
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
        setInstallPlatformIndex(0);
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
        label: '确定所选平台 [c]',
        disabled: validSelectedTargets.length === 0 ? '至少选择一个目标平台' : undefined,
        run: confirmNativePlatforms,
      };
      actions = [...nativeActions, portableAction, confirmAction];
      bottomActions = [confirmAction];
      help = '↑↓ 移动 · Enter/Space 选择 · Esc 返回';
      content = <Box flexDirection="column">
        <SemanticRows actions={actions.slice(0, nativeActions.length).map((action) => ({
          ...action, label: `${action.selected ? '[x]' : '[ ]'} ${action.label}`,
        }))} focus={focus} kind="action" compact={false} />
        <SemanticRows actions={actions} focus={focus} offset={nativeActions.length}
          kind="action" compact={false} />
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
      const platformIndex = Math.min(installPlatformIndex, Math.max(0, selectedPlatforms.length - 1));
      const platform = selectedPlatforms[platformIndex];
      title = platform ? `${platformLabel(platform)} 的使用范围` : '请返回选择目标平台';
      context = `平台 ${platformIndex + 1} / ${selectedPlatforms.length}`;
      if (platformIndex > 0) returnToPreviousInstallPlatform = () => {
        setInstallPlatformIndex(platformIndex - 1);
        setFocus(0);
        setScrollOffset(0);
      };
      actions = platform ? legalScopes(platform).map((candidateScope) => ({
        label: scopeLabel(candidateScope),
        selected: installPlatformScopes[platform] === candidateScope,
        description: platformIndex + 1 < selectedPlatforms.length
          ? `下一步：${platformLabel(selectedPlatforms[platformIndex + 1]!)} 的使用范围`
          : '下一步：查看这些精确目标的操作汇总',
        run: async () => {
          const nextScopes = { ...installPlatformScopes, [platform]: candidateScope };
          setInstallPlatformScopes(nextScopes);
          if (platformIndex + 1 < selectedPlatforms.length) {
            setInstallPlatformIndex(platformIndex + 1);
            setFocus(0);
            setScrollOffset(0);
            return;
          }
          const exactTargets = selectedPlatforms.flatMap((selectedPlatform) => {
            const selectedScope = nextScopes[selectedPlatform];
            return selectedScope && legalScopes(selectedPlatform).includes(selectedScope)
              ? [{ pluginId: plugin.pluginId, platform: selectedPlatform, scope: selectedScope }] : [];
          });
          if (exactTargets.length !== selectedPlatforms.length) {
            setInstallPlatformIndex(0);
            setFocus(0);
            setScrollOffset(0);
            setActionError('合法位置已变化。请重新确定每个平台的范围。');
            return;
          }
          props.controller.setInstallRootTargets(exactTargets);
          if (hasDependencies && await props.controller.prepareInstallDependencyPlacement()) {
            go({ name: 'dependencyPlacement', pluginId: plugin.pluginId });
            return;
          }
          beginReview(props.controller.installPlacementIntent());
        },
      })) : [];
    }
    content = <Box flexDirection="column">
      <SemanticRows actions={actions} focus={focus} kind="choice" compact={policy.mode === 'compact'} />
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
      { role: 'navigation' as const, label: '返回插件详情', run: back },
    ];
    content = <Box flexDirection="column">
      <SemanticRows actions={actions} focus={focus} kind="toggle" compact={policy.mode === 'compact'} limit={targetActions.length + 1} />
      <SemanticRows actions={actions} focus={focus} kind="action" compact={policy.mode === 'compact'} offset={targetActions.length + 1} />
    </Box>;
    help = '↑↓ 移动 · Enter 选择/继续 · Esc 返回';
  } else if (route.name === 'dependencyPlacement' && plugin) {
    const draft = snapshot.installPlacementDraft?.pluginId === plugin.pluginId
      ? snapshot.installPlacementDraft : undefined;
    const rootScopeSummary = draft?.exactRootTargets ? '按平台设置'
      : draft ? scopeLabel(draft.rootScope) : '未就绪';
    const exactRootRows = draft?.exactRootTargets?.map((target) => <StaticRow
      key={target.platform} title={`${platformLabel(target.platform)} · ${scopeLabel(target.scope)}`} compact />);
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
      { role: 'navigation' as const, label: '返回目标平台', run: back },
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
            <StaticRow title={`根插件 · ${plugin.displayName}`} meta={rootScopeSummary} compact />
            {exactRootRows}
            <StaticRow title={`位置原因 · ${reasonSummary || '由平台或上游约束固定'}`} status={userCount > 0 ? 'warning' : 'info'} compact />
            <StaticRow title="范围提示 · 所有项目位置会影响其他项目和用户环境" status={userCount > 0 ? 'warning' : 'muted'} compact />
          </>
        : <>
            <SectionCard title="根插件位置">
              <StaticRow title={plugin.displayName} meta={rootScopeSummary} compact />
              {exactRootRows}
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
            status: 'info',
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
    const mixedScopes = unifiedProjectScope
      && new Set(candidates.map((candidate) => candidate.target.scope)).size > 1;
    const startTaskReview = (executionPolicy: 'all' | 'executableSubset', selectedScope?: Scope): void => {
      if (targetSetChanged) {
        setActionError('本次安装位置已变化。请返回调整后重新开始。');
        return;
      }
      if (selectedScope) {
        startSplitTaskScope({ goal: route.goal,
          targets: candidates.map((candidate) => candidate.target),
          executionPolicy, currentScope: selectedScope,
          returnRoute: props.controller.pluginWriteTaskReturnRoute(route),
        }, selectedScope);
        return;
      }
      const intent: Extract<OperationIntent, { kind: 'pluginWriteTask' }> = {
        kind: 'pluginWriteTask',
        goal: route.goal,
        targets: candidates.map((candidate) => candidate.target),
        executionPolicy,
      };
      if (unifiedProjectScope) {
        beginReview(intent, props.controller.pluginWriteTaskReturnRoute(route));
      } else {
        props.controller.startPluginWriteTaskReview(intent,
          props.controller.pluginWriteTaskReturnRoute(route));
      }
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
      ...(!targetSetChanged && !versionEvidenceChanged && mixedScopes
        ? (['user', 'project'] as const).filter((selectedScope) => executable.some((candidate) =>
          candidate.target.scope === selectedScope)).map((selectedScope) => ({
          label: `先处理${scopeLabel(selectedScope)} ${executable.filter((candidate) => candidate.target.scope === selectedScope).length} 个位置`,
          description: `完整请求 ${candidates.length} 个位置；另一范围留待重新准备和确认`,
          status: 'warning' as const,
          run: () => startTaskReview(blockedCandidates.length > 0 ? 'executableSubset' : 'all', selectedScope),
        })) : []),
      ...(!mixedScopes && !targetSetChanged && !versionEvidenceChanged
        && blockedCandidates.length === 0 && executable.length > 0 ? [{
        label: `确认${taskLabel} ${executable.length} 个位置`,
        description: '进入统一影响确认；执行前再次检查当前证据',
        status: 'success' as const,
        run: () => startTaskReview('all'),
      }] : []),
      ...(!mixedScopes && !targetSetChanged && !versionEvidenceChanged
        && blockedCandidates.length > 0 && executable.length > 0 ? [{
        label: `先处理可执行的 ${executable.length} 个位置`,
        description: `${blockedCandidates.length} 个受阻位置保留，不会无声跳过`,
        status: 'warning' as const,
        run: () => startTaskReview('executableSubset'),
      }] : []),
      ...activationSources.map((sourceId) => ({
        label: `先更新来源目录 ${sourceId}`,
        description: '先单独确认目录变更；启用完成后重新准备插件更新',
        status: 'info' as const,
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
      { role: 'navigation' as const, label: route.recommendedPluginIds ? '返回调整选择' : '返回插件详情', run: back },
    ];
    const taskTargetLimit = policy.mode === 'compact' ? 3 : 6;
    readingText = candidates.map((candidate) => {
      const target = candidate.target;
      const version = target.expectedUpdate
        ? `${target.expectedUpdate.installedVersion} → ${target.expectedUpdate.activeVersion}`
        : '保持当前版本';
      return `${candidate.displayName} · ${candidate.sourceId} · ${platformLabel(target.platform)} · ${scopeLabel(target.scope)} · ${candidate.eligible
        ? pluginWriteTaskMethodLabel(candidate.recommendedMethod)
        : pluginWriteTaskBlockLabel(candidate.blockReason)} · ${version}`;
    }).join('\n');
    if (candidates.length > taskTargetLimit) {
      referenceDetailPagination = { total: candidates.length, pageRows: taskTargetLimit };
    }
    const taskPage = pagedItems(candidates.length, taskTargetLimit);
    const visibleTaskCandidates = candidates.slice(taskPage.offset, taskPage.offset + taskTargetLimit);
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
      pageActionBudget(Math.min(candidates.length, policy.mode === 'compact' ? 3 : 6) + 3));
    content = <Box flexDirection="column">
      <SectionCard title="处理范围" meta={`${executable.length} 个可执行 · ${blockedCandidates.length} 个需决定`} compact={policy.mode === 'compact'}>
        {targetRows.length > 0 ? targetRows
          : <StaticRow title="当前没有可执行目标" status="muted" compact />}
        {taskPage.pageCount > 1
          ? <Pager page={taskPage.page} pageCount={taskPage.pageCount} columns={size.columns - 6} /> : null}
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
  } else if (route.name === 'pluginDetail' && detailSubject && !plugin) {
    breadcrumb = `插件 / ${detailSubject.displayName}`;
    title = '';
    description = undefined;
    context = '插件详情';
    const issues = props.controller.listUserIssues().filter((entry) =>
      issueMatchesTarget(entry, detailSubject.pluginId));
    const root = props.controller.getProjectInventoryRoot(detailSubject.pluginId);
    actions = [
      ...(issues.length > 0 ? [{ actionId: 'exceptional', label: '查看处理建议',
        status: 'warning' as const,
        run: () => go(issues.length === 1
          ? { name: 'issueDetail', issueId: issues[0]!.issueId } : { name: 'issueList' }) }] : []),
      ...(detailSubject.savedConfigScopes.length > 0 ? [{ actionId: 'settings',
        label: '查看已保存设置', run: () => props.controller.beginSavedConfigRecovery(detailSubject.pluginId) }] : []),
      ...(detailSubject.relations.hasKnownRelations ? [{ actionId: 'dependencies',
        label: '依赖关系', run: () => go({ name: 'pluginDependencies', pluginId: detailSubject.pluginId }) }] : []),
      ...(props.controller.getSourceOverview(detailSubject.sourceId).source ? [{ actionId: 'source',
        label: '查看插件来源', run: () => go({ name: 'sourceDetail', sourceId: detailSubject.sourceId }) }] : []),
      ...(root && root.state !== 'ready' && issues.length === 0 ? [{ actionId: 'project-recheck',
        label: '重新检查项目', run: async () => { await props.controller.refreshProjectInventory(); } }] : []),
    ];
    content = detailCardContent(detailSubject);
  } else if (route.name === 'pluginDetail' && plugin && detailSubject) {
    breadcrumb = `插件 / ${plugin.displayName}`;
    context = `${plugin.sourceLabel}${plugin.version ? ` · ${plugin.version}` : ''}`;
    title = plugin.displayName;
    description = '';
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
        status: 'info',
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
          status: 'info',
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
    const installAction: ActionItem | undefined = !plugin.catalogEntryMissing ? {
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
    const contentAction: ActionItem | undefined = !plugin.catalogEntryMissing
      && detailSubject.definitionAvailable ? {
      actionId: 'content',
      label: '内容详情',
      description: contentOverview
        ? `${contentOverview.items.length} 项当前目录内容`
        : '打开时读取当前目录版本的内容',
      run: () => go({ name: 'pluginContent', pluginId: plugin.pluginId }),
    } : undefined;
    const dependencyOverviewForDetail = dependencyOverview(plugin);
    const dependencyAction: ActionItem | undefined = !plugin.catalogEntryMissing
      && detailSubject.relations.hasKnownRelations ? {
          actionId: 'dependencies',
          label: '依赖关系',
          description: dependencyOverviewForDetail
            && (dependencyOverviewForDetail.dependencies.length > 0
              || dependencyOverviewForDetail.dependents.length > 0
              || dependencyOverviewForDetail.blockers.length > 0)
            ? '在同一关系图中查看使用者和所需插件'
            : '当前没有已声明的所需插件或使用者',
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
    const cleanupAction: ActionItem | undefined = plugin.configOnly
      || plugin.removedPluginCleanupRequired ? {
      actionId: 'cleanup',
      label: plugin.removedPluginCleanupRequired ? '清理已删除插件' : '检查并清理插件残留',
      description: plugin.removedPluginCleanupRequired
        ? '预览两个平台、用户与当前项目中的残留和保存设置，再确认实际清理范围'
        : '先核验当前来源和现场，再显示可清理内容与实际范围',
      status: 'error',
      run: () => {
        const target = props.controller.listPluginWriteBatchTargets('cleanup', [plugin.pluginId])[0];
        beginReview({
          kind: 'pluginWrite', action: 'cleanup', pluginId: plugin.pluginId,
          platform: target?.platform ?? 'codex',
          scope: target?.scope ?? plugin.savedConfigScopes[0] ?? 'user',
        });
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
      ...(cleanupAction ? [cleanupAction] : []),
      {
        actionId: 'more',
        label: '更多操作',
        description: '平台维护、来源和诊断',
        run: () => go({ name: 'pluginMore', pluginId: plugin.pluginId }),
      },
    ]);
    context = '插件详情';
    title = '';
    description = undefined;
    const completion = snapshot.completionNotice?.pluginId === plugin.pluginId
      ? snapshot.completionNotice : undefined;
    const completionLines = completion
      ? wrapConsoleText(`${completion.title} · ${completion.description}`, size.columns - 2) : [];
    content = detailCardContent(detailSubject, completionLines);
  } else if (route.name === 'pluginMore' && plugin) {
    breadcrumb = `插件 / ${plugin.displayName} / 更多操作`;
    context = plugin.sourceLabel;
    title = '更多操作';
    description = '选择平台可使用同步、重新安装、移除和受限清理。';
    const detail = props.controller.getPluginDetailSubject(plugin.pluginId);
    const platforms = plugin.installedPlacements.filter((placement) => placement.state !== 'notInstalled');
    const entryFacts = platforms.map((placement) => detail?.placements
      .filter((entry) => entry.platform === placement.platform) ?? []);
    actions = [
      ...platforms
        .map((placement): ActionItem => {
          return {
            actionId: `platform:${placement.platform}`,
            label: `${platformLabel(placement.platform)} 平台维护`,
            run: () => go({ name: 'platform', pluginId: plugin.pluginId, platform: placement.platform }),
          };
        }),
      { label: '查看插件来源', run: () => go({ name: 'sourceDetail', sourceId: plugin.sourceId }) },
      { label: '诊断与技术详情', description: '查看插件身份、组件状态和安全错误代码', run: () => go({ name: 'pluginTechnical', pluginId: plugin.pluginId }) },
    ];
    const cardWidth = size.columns - 2;
    const moreViewport = rowViewport({ rowHeights: actions.map((_, index) => index < platforms.length
      ? 2 + (entryFacts[index]!.length ? entryFacts[index]!.reduce((height, fact) => height
        + entityPlacementRowHeight({ ...fact, shared: fact.sharedWithCurrentProject }, cardWidth), 0) : 1)
      : 1), focus, requestedOffset: scrollOffset, rowBudget: pageActionBudget(0) });
    content = <ContentViewport>{actions.slice(moreViewport.offset, moreViewport.offset + moreViewport.limit)
      .map((action, visibleIndex) => {
        const index = moreViewport.offset + visibleIndex;
        return index < platforms.length ? <ObjectCardFrame key={action.actionId} width={cardWidth}
          title={action.label} focused={focus === index}>
          {entryFacts[index]!.length ? entryFacts[index]!.map((fact) =>
            <EntityPlacementRow key={fact.scope} placement={{ ...fact, shared: fact.sharedWithCurrentProject }}
              width={cardWidth} />) : <Text color={tuiTheme.colors.muted}>位置状态未确认</Text>}
        </ObjectCardFrame> : <SemanticRows key={index} actions={actions} focus={focus} kind="action"
          compact offset={index} limit={1} />;
      })}</ContentViewport>;
  } else if (route.name === 'platform' && plugin) {
    const aggregatePlacement = props.controller.getPlatformPlacement(plugin.pluginId, route.platform);
    const placement = aggregatePlacement?.state === 'installed' && platformSelectedScope
      ? { ...aggregatePlacement,
        ...(aggregatePlacement.scopedPlacements?.find((entry) => entry.scope === platformSelectedScope) ?? {}) }
      : aggregatePlacement;
    const platformMenu = dynamicMenu!;
    const typedIssue = platformSelectedScope
      ? props.controller.listUserIssues().find((candidate) =>
          candidate.pluginId === plugin.pluginId
          && candidate.platform === route.platform
          && candidate.scope === platformSelectedScope)
      : undefined;
    const collisionIssue = placement?.state === 'blocked'
      || placement?.state === 'installed' && placement.blockingReason === 'artifactCollision'
      ? props.controller.listUserIssues().find((candidate) =>
          candidate.pluginId === plugin.pluginId
          && candidate.platform === route.platform
          && (!platformSelectedScope || candidate.scope === platformSelectedScope)
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
        status: 'info',
        run: () => go({ name: 'pluginTechnical', pluginId: plugin.pluginId,
          platform: route.platform, scope: platformSelectedScope }),
      };
      if (action.id === 'capabilityTechnical') return {
        label: '查看功能支持详情',
        description: '查看缺少的功能和安全恢复方向',
        run: () => go({ name: 'pluginTechnical', pluginId: plugin.pluginId,
          platform: route.platform, scope: platformSelectedScope }),
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
        description: `补充安装目标：${platformLabel(action.platform)} · ${scopeLabel(action.scope)}；在操作汇总中确认。`,
        run: () => beginSecondScope(plugin, action.platform, action.scope),
      };
      if (action.id === 'about') return { label: '查看支持信息', description: '插件定义与平台支持', run: () => go({ name: 'pluginTechnical', pluginId: plugin.pluginId, platform: route.platform, scope: platformSelectedScope }) };
      if (action.id === 'source') return { label: '查看来源', run: () => go({ name: 'sourceDetail', sourceId: plugin.sourceId }) };
      if (action.id === 'outputCollision') return {
        label: '查看输出冲突',
        description: '不会覆盖或删除占用内容',
        status: 'error',
        run: () => collisionIssue
          ? go({ name: 'issueDetail', issueId: collisionIssue.issueId })
          : go({ name: 'pluginTechnical', pluginId: plugin.pluginId,
            platform: route.platform, scope: platformSelectedScope }),
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
        status: 'info',
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
        status: 'info',
        description: placement?.state === 'installed'
          ? (placement.scopedPlacements?.find((entry) => entry.scope === action.scope)?.recovery
            ?? placement.recovery)?.find((entry) => entry.command === 'sync')?.description
            ?? '重新检查已保存位置，并在操作汇总中显示需要处理的项目'
          : undefined,
        run: () => placement?.state === 'installed'
          ? beginReview({ kind: 'pluginWrite', action: 'sync', pluginId: plugin.pluginId, platform: action.platform, scope: action.scope })
          : undefined,
      };
      if (action.id === 'reinstall') return { label: `重新安装${scopeLabel(action.scope)}位置`, status: 'info', description: '保留现有设置并重新生成受管内容', run: () => beginReview({ kind: 'pluginWrite', action: 'reinstall', pluginId: plugin.pluginId, platform: action.platform, scope: action.scope }) };
      if (action.id === 'remove') return { label: `从${scopeLabel(action.scope)}移除`, description: '保留插件设置', status: 'error', run: () => beginPluginRemoval(plugin, action.platform, action.scope) };
      if (action.id === 'cleanup') return { label: `清理${scopeLabel(action.scope)}中的遗留内容`, description: '先核验，再取消此位置的使用设置，并尽力清理可验证的 AW 内容', status: 'error', run: () => beginReview({ kind: 'pluginWrite', action: 'cleanup', pluginId: plugin.pluginId, platform: action.platform, scope: action.scope }) };
      if (action.id === 'technical') return typedIssue
        ? { label: '查看对应问题', description: typedIssue.explanation, run: () => go({ name: 'issueDetail', issueId: typedIssue.issueId }) }
        : { label: placement?.state === 'installed' && placement.health === 'error' ? '查看安全技术详情' : placement?.state === 'installed' && placement.health === 'incomplete' ? '查看影响' : '查看安装详情', description: '组件与诊断信息', run: () => go({ name: 'pluginTechnical', pluginId: plugin.pluginId, platform: route.platform, scope: platformSelectedScope }) };
      return { role: 'navigation' as const, label: '返回插件', run: back };
    };
    const offlineCleanupAction = typedIssue?.actions.find((action) => action.id === 'cleanup');
    const offlineCleanup = typedIssue !== undefined
      && placement?.state === 'installed'
      && placement.blockingReason === undefined
      && (placement.actualState === 'orphaned' || placement.actualState === 'blocked')
      && platformSelectedScope === placement.scope
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
      && platformSelectedScope === placement.scope
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
      ...platformMenu.filter((action) =>
        action.id === 'addScope' || !('scope' in action) || action.scope === platformSelectedScope)
        .filter((action) => platformSelectedScope !== undefined
          || !('scope' in action))
        .filter((action) => platformSelectedScope !== undefined
          || platformFacts.length === 0
          || action.id !== 'technical' && action.id !== 'outputCollision')
        .filter((action) => {
          const selectedFact = platformFacts.find((entry) => entry.scope === platformSelectedScope);
          return selectedFact?.observation !== 'unknown'
            || !['refreshAndSync', 'sync', 'reinstall', 'remove', 'cleanup'].includes(action.id);
        }).map((action) => ({ ...platformAction(action),
          actionId: pluginMenuActionId(action) })),
      ...(offlineCleanup ? [{ ...offlineCleanup,
        actionId: `offlineCleanup:${route.platform}:${platformSelectedScope}` }] : []),
      ...(restrictedForceCleanup ? [{ ...restrictedForceCleanup,
        actionId: `forceCleanup:${route.platform}:${platformSelectedScope}` }] : []),
    ];
    breadcrumb = `${plugin.displayName} / ${platformLabel(route.platform)}`;
    const selectedFact = platformFacts.find((entry) => entry.scope === platformSelectedScope);
    const selectedIssue = platformSelectedScope ? props.controller.listUserIssues().find((candidate) =>
      candidate.pluginId === plugin.pluginId && candidate.platform === route.platform
      && candidate.scope === platformSelectedScope) : undefined;
    const factActions: ActionItem[] = platformFacts.map((entry) => ({
      actionId: `placement:${entry.platform}:${entry.scope}`,
      label: `${platformLabel(entry.platform)} · ${scopeLabel(entry.scope)}`,
      selected: entry.scope === platformSelectedScope,
      run: () => {
        props.controller.updatePageContext({
          platformSelectionInitialized: true,
          platformSelectedScope: entry.scope,
        });
        dynamicMenuFocus.current = undefined;
        setActionError(undefined);
      },
    }));
    actions = [...factActions, ...platformActions()];
    dynamicActionIds = actions.map((action) => action.actionId!);
    dynamicActionSignature = dynamicActionIds.join('\0');
    const previousDynamicFocus = dynamicMenuFocus.current;
    if (previousDynamicFocus?.routeKey === routeKey
      && previousDynamicFocus.actionIds !== dynamicActionSignature) {
      const retained = previousDynamicFocus.focusedActionId
        ? dynamicActionIds.indexOf(previousDynamicFocus.focusedActionId) : -1;
      const selectedCard = platformSelectedScope
        ? dynamicActionIds.indexOf(`placement:${route.platform}:${platformSelectedScope}`) : -1;
      effectiveFocus = retained >= 0 ? retained : Math.max(0, selectedCard);
    }
    const cardWidth = size.columns - 2;
    const rowHeights = actions.map((action, index) => index < platformFacts.length
      ? entityPlacementRowHeight({ ...platformFacts[index]!, shared:
        platformFacts[index]!.sharedWithCurrentProject }, cardWidth) + 2
      : action.role === 'navigation' ? 0 : 1);
    title = `${platformLabel(route.platform)} 维护`;
    description = selectedFact
      ? `${scopeLabel(selectedFact.scope)} · ${selectedFact.observation === 'unknown'
        ? '位置状态未确认；普通写操作不可用。'
        : selectedIssue?.explanation ?? (placement?.state === 'installed'
          && placement.blockingReason === 'artifactCollision'
          ? '输出位置存在冲突内容；不会覆盖或删除占用内容。'
          : placement?.state === 'installed' && placement.sharedNative?.reason === 'outdated'
            ? '已安装版本与当前 Catalog 版本不一致。'
            : '仅显示此位置获许可的动作。')}`
      : platformFacts.length > 0 ? '先按 Enter 选择一个位置，再执行该位置的操作。'
        : plugin.aggregateStatus === 'unavailable'
          ? capabilityUnavailable ? '当前 AW CLI 不支持此插件所需功能。'
            : sourceIssue?.explanation ?? '来源当前不可用；请检查来源。'
          : placement?.state === 'blocked' ? '输出位置已有冲突内容；不会覆盖或删除。'
            : placement?.state === 'scopeConflict' ? '安装位置冲突；请先查看问题。'
              : '当前没有已确认的安装位置。';
    const viewport = rowViewport({ rowHeights, focus: effectiveFocus,
      requestedOffset: scrollOffset, rowBudget: pageActionBudget(1) });
    help = '↑↓ 移动焦点 · Enter 选择位置或动作 · Esc 返回';
    content = <Box flexDirection="column">
      <StaticRow title="使用位置" meta={`${platformFacts.length} 个`} compact />
      <ContentViewport>{actions.slice(viewport.offset, viewport.offset + viewport.limit)
        .map((action, visibleIndex) => {
          const index = viewport.offset + visibleIndex;
          if (index >= platformFacts.length) return <SemanticRows key={action.actionId ?? index}
            actions={actions} focus={effectiveFocus} kind="action" compact
            offset={index} limit={1} />;
          const fact = platformFacts[index]!;
          return <ObjectCardFrame key={action.actionId} width={cardWidth} focused={effectiveFocus === index}
            title={`${scopeLabel(fact.scope)} ${fact.scope === platformSelectedScope ? '[选定]' : '[选择]'}`}>
            <EntityPlacementRow placement={{ ...fact, shared: fact.sharedWithCurrentProject }}
              width={cardWidth} />
          </ObjectCardFrame>;
        })}</ContentViewport>
    </Box>;
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
          : fieldValueText(selectedField, selectedMutation.value)
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
    description = undefined;
    if (configActionError) description = configActionError;
    help = 'Esc 返回';
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
        description = `${description ?? ''} 有 ${configDraftIssues.length} 项未保存修改已不适用于当前设置。`;
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
            description: field.invalidOverrideIssue ?? field.description,
            configTile: (() => {
              const project = pendingFieldDisplay(field, 'project');
              const user = pendingFieldDisplay(field, 'user');
              const covered = user !== undefined && field.effectiveSourceLabel === '当前项目' && project === undefined;
              const pending = project ?? (covered ? undefined : user);
              const targets = pendingFieldTargets(field);
              return {
                value: pending ?? effectiveFieldDisplay(field),
                source: field.effectiveSourceLabel,
                description: field.description?.split('\n').map(safeConfigText).join('\n'),
                issue: field.invalidOverrideIssue?.split('\n').map(safeConfigText).join('\n'),
                invalid: Boolean(field.invalidOverrideIssue),
                ...(targets.length ? { pending: covered
                  ? '待保存到个人；个人修改不会影响本项目'
                  : `待保存到${targets.map(({ scope }) => configLayerLabel({ scope })).join('、')}` } : {}),
              };
            })(),
            configKey: field.key,
            run: () => go({
              name: 'configFieldEditor', pluginId: plugin.pluginId, layer: mutableLayer,
              fieldKey: field.key, editor: fieldEditor(field), ...fieldEditorMode(field),
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
        label: configDraftCount > 0 ? `保存设置（${configDraftCount}） [s]` : '保存设置 [s]',
        description: '确认全部设置层的变化，再选择只保存或保存并应用',
        status: configDraftCount > 0 ? 'info' : 'muted',
        disabled: configDraftCount === 0 ? '没有待保存设置'
          : configDraftIssues.length > 0 ? '请先放弃失效草稿' : undefined,
        run: () => {
          setFocus(0);
          setScrollOffset(0);
          beginConfigSave(true);
        },
      };
      bottomActions = [configSaveAction, {
        label: '设置选项', run: () => go({ ...route, view: 'options' }),
      }];
      actions = [...tabActions, ...bottomActions];
      if (route.view === 'options') {
        title = '设置选项';
        description = '查看各层存储值，或清空一个保存位置。';
        actions = [{ label: '查看当前值的来源', run: () => {
          setBatchTargetOffset(0);
          go({ ...route, view: 'values' });
        } }, ...operationActions];
      }
      const effectiveConfigFocus = Math.min(focus, Math.max(0, actions.length - 1));
      const focusedConfigField = activeGroup?.fields.find((field) =>
        field.key === actions[effectiveConfigFocus]?.configKey);
      const configRowBudget = pageActionBudget(Number(visibleConfigTabs.length > 1)
        + (configDraftIssues.length > 0 ? 3 : 0));
      const focusedTile = actions[effectiveConfigFocus]?.configTile;
      if (focusedTile && route.view !== 'options' && route.view !== 'values') {
        const key = `${routeKey}:${focusedConfigField?.key}`;
        const pageCount = Math.max(1, Math.ceil((configTileHeight({ width: size.columns - 2,
          ...focusedTile, focused: true }) - 2) / Math.max(1, configRowBudget - 3)));
        configCardNavigation = { key, pageCount,
          page: Math.min(pageCount, configCardPage?.key === key ? configCardPage.page : 1) };
      }
      if (!readonly) {
        const canUnsetFocused = focusedConfigField
          ? (['project', 'user'] as const).some((scope) =>
              configLayerPages[scope]?.groups.flatMap((group) => group.fields)
                .some((field) => field.key === focusedConfigField.key && configFieldCanUnset(field)))
          : false;
        help = `↑↓ 选择 · Enter ${focusedConfigField ? '修改' : '选择'}${!route.view && visibleConfigTabs.length > 1
          ? ' · ←→ 分组' : ''}${(configCardNavigation?.pageCount ?? 1) > 1 ? ' · PgUp/PgDn 卡片全文' : ''}`
          + `${configDraftCount > 0 ? ' · s 查看汇总' : ''}${canUnsetFocused ? ' · u 恢复继承' : ''} · Esc 返回`;
      }
      const totalFields = currentConfigPage.groups.reduce((count, group) => count + group.fields.length, 0);
      const countLabel = `${totalFields} 项${currentConfigPage.presets.length > 0 ? ` · ${currentConfigPage.presets.length} 个方案` : ''}`;
      context = configDraftCount > 0 ? `${configDraftCount} 项待保存` : countLabel;
      content = route.view === 'options' ? <SemanticRows actions={actions} focus={focus} kind="action" compact={policy.mode === 'compact'} />
        : route.view === 'values' ? (() => {
          title = '完整设置值与来源';
          description = '显示各保存位置的完整安全值；敏感值不回显。';
          readingText = (['effective', 'project', 'user'] as const).flatMap((scope) =>
            ((scope === 'effective' ? currentConfigPage : configLayerPages[scope])?.groups.flatMap((group) => group.fields) ?? []).map((field) =>
              `${field.title} · ${configLayerLabel({ scope })}：${scope === 'effective'
                ? field.invalidOverrideIssue ? '需修正' : fieldValueText(field, field.draftValue ?? field.effectiveValue, true, field.effectiveSourceLabel !== '未设置')
                : fieldValueText(field, field.draftValue ?? field.value, true, field.configured)}`)).join('\n');
          actions = [{ label: '返回设置', run: back }];
          help = '←→ 或 PgUp/PgDn 阅读 · Esc 返回';
          return <Box flexDirection="column">
            {readingPage(readingText, size.columns - 2, Math.max(1, pageActionBudget(4) - 1))}
            <SemanticRows actions={actions} focus={focus} kind="action" compact />
          </Box>;
        })() : <Box flexDirection="column">
        {!readonly && configDraftIssues.length > 0 ? <Callout
          status="warning"
          title="有未保存修改无法继续使用"
          description="插件来源恢复后，设置内容或可用位置已变化。请放弃这些修改，或返回检查插件来源；系统不会自动保存。"
        /> : null}
        {activeTab && visibleConfigTabs.length > 1 ? <QueryHeader width={size.columns - 2}
          tabs={{ label: '分组', items: visibleConfigTabs.map((tab) => ({
            id: tab.id, label: tab.label, count: tab.count,
          })), currentId: activeTab.id }} /> : null}
        <SequenceRows actions={actions} itemCount={tabActions.length}
          focus={effectiveConfigFocus} scrollOffset={scrollOffset} columns={size.columns - 2}
          rowBudget={configRowBudget} configPage={configCardNavigation?.page}
          compact={policy.mode === 'compact'} />
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
      readingText = changeDetailText(changes);
      const pageRows = Math.max(1, Math.min(
        responsiveBudget(5, 10),
        pageActionBudget(5) - 1,
      ));
      breadcrumb = `${plugin.displayName} / 设置 / 完整变化`;
      title = '完整设置变化';
      description = '逐项显示修改前和修改后的完整值。';
      help = '←→ 或 PgUp/PgDn 阅读 · ↑↓ 移动 · Enter 选择 · Esc 返回保存汇总';
      actions = [
        { label: '返回保存汇总', run: back },
      ];
      content = <Box flexDirection="column">
        {readingPage(readingText, size.columns - 2, pageRows)}
        <SemanticRows actions={actions} focus={focus} kind="action" compact />
      </Box>;
    } else {
    const visibleChanges = changes.slice(0, 2);
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
    const summaryLines = visibleChanges.flatMap((change) => {
      const lines = wrapConsoleText(`${change.title} · ${change.before ?? '未设置'} → ${change.after}`, Math.max(1, size.columns - 4));
      return lines.length > 2 ? [lines[0]!, `${lines[1]}…`] : lines;
    });
    const configSaveActionViewport = actionViewport(actions, policy.mode === 'compact', focus,
      scrollOffset, pageActionBudget(summaryLines.length + 2));
    content = <Box flexDirection="column">
      {summaryLines.map((line, index) => <Text key={index}>{line}</Text>)}
      {changes.length > visibleChanges.length ? <Text>另有 {changes.length - visibleChanges.length} 项；完整变化中可读</Text> : null}
      <Text>每层独立提交；失败层保留草稿</Text>
      <SemanticRows actions={actions} focus={focus} kind="action" compact={policy.mode === 'compact'}
        offset={configSaveActionViewport.offset} limit={configSaveActionViewport.limit} />
    </Box>;
    }
  } else if (route.name === 'configFieldEditor' && plugin && activeField) {
    breadcrumb = `${plugin.displayName} / 设置 / ${activeField.title}`;
    const showChoices = (activeField.choices?.length ?? 0) > 0 && route.mode !== 'custom';
    const targetFields = (['project', 'user'] as const).flatMap((scope) =>
      configLayerPages[scope]?.groups.flatMap((group) => group.fields).filter((field) => field.key === activeField.key) ?? []);
    const canSet = targetFields.some(configFieldCanSet);
    const canUnset = !arrayItem && targetFields.some(configFieldCanUnset);
    if (!canSet) {
      title = activeField.title;
      description = activeField.invalidOverrideIssue ?? '此旧值不允许修改；可以删除覆盖并恢复继承。';
      actions = canUnset ? [{ label: '删除此覆盖并恢复继承', run: () => removeDraft(activeField.key) }] : [];
      content = <Box flexDirection="column"><StatusCard status="warning" title="仅可删除旧值" description={description} />
        <SemanticRows actions={actions} focus={focus} kind="action" compact /></Box>;
    } else if (showChoices) {
      title = `选择${activeField.title}`;
      description = activeField.type !== 'boolean' && activeField.allowCustom
        ? '先选择插件提供的方案，也可以继续自定义。'
        : '此字段只允许使用插件提供的方案。';
      help = '↑↓ 移动 · Enter 使用 · Esc 取消';
      const current = activeCandidateMutation?.kind === 'set'
        ? activeCandidateMutation.value
        : (arrayItem ? itemValue : draftUpdates[activeField.key]) ?? activeField.draftValue ?? activeField.value;
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
    } else if (route.editor === 'array' && activeField.definition.type === 'array') {
      title = activeField.title;
      description = objectError ?? `${activeArrayDraft?.rows.length ?? 0} 项 · 顺序将按当前列表保存`;
      help = '↑↓ 移动 · Enter 编辑 · c 使用此列表 · Esc 取消';
      const rows = activeArrayDraft?.rows ?? [];
      const definition = activeField.definition;
      const errors = activeArrayDraft ? validatePluginConfigValue(definition, arrayDraftValue(activeArrayDraft), activeField.key) : [];
      const itemActions: ActionItem[] = rows.map((row, index) => ({
        actionId: `array:${row.rowId}`,
        label: `${String(index + 1).padStart(2, '0')}  ${presentConfigValue({ definition: definition.items, value: row.value, summary: activeField.itemSummary }).text}`,
        run: () => openArrayItem(row.rowId),
      }));
      bottomActions = [{
        label: '添加一项', run: () => openArrayItem(),
        disabled: rows.length >= (definition.validation?.maxItems ?? PLUGIN_CONFIG_ARRAY_MAX_ITEMS) ? '已达到列表最大项数' : undefined,
      }, {
        label: '调整当前项', disabled: rows.length === 0 ? '列表为空' : undefined,
        run: () => { setArrayToolFocus(0); setArrayToolsOpen(true); },
      }, { label: '使用此列表 [c]', run: commitArray }];
      actions = [...itemActions, ...bottomActions];
      content = <Box flexDirection="column">
        {rows.length === 0 ? <Text>空列表；确认使用后覆盖原值。</Text> : null}
        {errors.length ? <Text color={tuiTheme.colors.warning}>{errors.slice(0, 2).map(objectIssueText).join('；')}</Text> : null}
        <SequenceRows actions={actions} itemCount={itemActions.length} focus={focus} scrollOffset={scrollOffset}
          compact columns={size.columns} rowBudget={pageActionBudget(errors.length ? 5 : 3)} />
      </Box>;
    } else if (route.editor === 'boolean') {
      title = `${activeField.title}？`;
      description = activeField.description ?? '选择开启或关闭。';
      help = '↑↓ 移动 · Enter 使用 · Esc 取消';
      const current = activeCandidateMutation?.kind === 'set'
        ? activeCandidateMutation.value
        : (arrayItem ? itemValue : draftUpdates[activeField.key]) ?? activeField.value;
      actions = [{ label: '开启', selected: !activeField.sensitive && current === true, run: () => updateDraft(activeField.key, true) }, { label: '关闭', selected: !activeField.sensitive && current === false, run: () => updateDraft(activeField.key, false) }];
      content = <SemanticRows actions={actions} focus={focus} kind="choice" compact={policy.mode === 'compact'} />;
    } else if (route.editor === 'object' && activeField.definition.type === 'object' && activeObjectDraft) {
      const objectDefinition = activeField.definition;
      title = `编辑${activeField.title}`;
      description = arrayItem ? '确认后更新当前列表项；列表尚未保存。' : activeField.configured
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
        const presentation = presentConfigValue({ definition,
          value: activeObjectDraft[property], privateValue: activeField.sensitive,
          configured: Object.hasOwn(activeObjectDraft, property),
        });
        return presentation.state === 'unset' && 'required' in definition && definition.required
          ? '必填 · 未设置' : presentation.text;
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
            ...(arrayItem ? { arrayItem } : {}),
          }),
        }] : []),
        {
          label: arrayItem ? '使用这一项 [c]' : '使用此完整对象',
          description: arrayItem ? '确认完整对象后返回列表' : `${Object.keys(activeObjectDraft).length} 个属性将作为单个顶层值保存`,
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
      if (arrayItem) {
        for (const action of propertyActions) {
          action.configKey = action.label;
          action.configTile = { value: action.meta ?? '未设置', source: '' };
        }
        content = <SequenceRows actions={actions} itemCount={propertyActions.length}
          focus={focus} scrollOffset={scrollOffset} columns={size.columns - 2}
          rowBudget={pageActionBudget(2)} compact />;
      }
    } else {
      title = activeField.sensitive ? '输入敏感值' : `输入${activeField.title}`;
      help = '输入 · Enter 使用 · Ctrl-U 清空输入 · Esc 取消';
      description = route.editor === 'number'
        ? `允许范围：${activeField.min ?? '不限'}–${activeField.max ?? '不限'}${activeField.unit ? ` ${activeField.unit}` : ''}。`
        : activeField.sensitive ? '当前值不会回显；留空不会自动删除旧值。' : activeField.description ?? '';
      content = <InputCard focused title={<InputDisplay value={inputValue} sensitive={activeField.sensitive} placeholder={activeField.placeholder} columns={Math.max(8, size.columns - 8)} />} description={inputError ?? (activeField.sensitive ? '输入已隐藏。' : activeField.placeholder ?? '按 Enter 使用输入值。')} status={inputError ? 'error' : undefined} />;
    }
    if (canUnset) {
      const unset: ActionItem = { label: '恢复继承', description: '选择要删除覆盖值的位置', run: () => removeDraft(activeField.key) };
      const inputEditor = canSet && !showChoices && (route.editor === 'number' || route.editor === 'string');
      help += ' · Ctrl-R 恢复继承';
      if (!inputEditor) {
        const offset = actions.length;
        actions.push(unset);
        content = <Box flexDirection="column">{content}<SemanticRows actions={actions} offset={offset} focus={focus} kind="action" compact /></Box>;
      }
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
    if (showTechnical) readingText = diagnosticDetailText(diagnostic);
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
      { role: 'navigation' as const, label: '返回', run: back },
    ];
    const unsupportedScopes = resetScopes.filter((scope) =>
      configResetAvailability[scope]?.resettable === false);
    const unsupportedRows = unsupportedScopes.map((scope) => <StaticRow
      key={`unsupported-reset:${scope}`}
      title={`${scope === 'user' ? '个人默认' : '当前项目'}设置层不能自动重置：特殊节点，请手动移动`}
      status="warning"
      compact
    />);
    const technicalPageRows = responsiveBudget(2, 4);
    if (showTechnical && !invalidLayer) {
      referenceDetailPagination = {
        total: diagnosticDetailLines(diagnostic, size.columns - 6).length,
        pageRows: technicalPageRows,
      };
      help = '←→ 或 PgUp/PgDn 阅读技术字段 · ↑↓ 移动 · Enter 选择 · Esc 返回';
    }
    const unavailableActionViewport = actionViewport(actions, true, focus, scrollOffset,
      pageActionBudget(technicalPageRows + 6 + unsupportedRows.length));
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
      : <Box flexDirection="column"><DiagnosticSummary diagnostic={diagnostic} technical={showTechnical}
          columns={size.columns} offset={showTechnical ? batchTargetOffset : undefined}
          limit={showTechnical ? technicalPageRows : undefined} compact={policy.mode === 'compact'} />
        {unsupportedRows}<SemanticRows actions={actions} focus={focus} kind="action"
          compact={showTechnical || policy.mode === 'compact'}
          offset={showTechnical ? unavailableActionViewport.offset : undefined}
          limit={showTechnical ? unavailableActionViewport.limit : undefined} /></Box>;
  } else if (route.name === 'sourceList') {
    breadcrumb = '插件来源';
    title = '插件来源';
    description = '单个来源失败不会阻止其他来源继续工作。';
    context = `${props.controller.listSources().length} 个来源`;
    help = '↑↓ 移动 · Enter 打开 · Esc 返回';
    const allSources = props.controller.listSources();
    const sourceKinds = new Set(allSources.map((source) =>
      props.controller.getConfiguredSource(source.id)?.type
        ?? props.controller.getSourceOverview(source.id).detail?.type));
    const hasTypeTabs = sourceKinds.has('git') && sourceKinds.has('path');
    const sourceType = hasTypeTabs ? snapshot.router.current.context.sourceTypeTab ?? 'all' : 'all';
    const visibleSources = matchingSources(props.controller, query, sourceType);
    moveSourceType = hasTypeTabs ? (direction) => {
      const tabs = ['all', 'git', 'path'] as const;
      const index = tabs.indexOf(sourceType);
      const next = tabs[(index + direction + tabs.length) % tabs.length]!;
      const nextSources = matchingSources(props.controller, query, next);
      const focusedId = actions[focus]?.actionId;
      const retained = nextSources.findIndex((source) => `source:${source.id}` === focusedId);
      props.controller.updatePageContext({ sourceTypeTab: next });
      setFocus(retained >= 0 ? retained : Math.min(focus, Math.max(0, nextSources.length - 1)));
      setScrollOffset(0);
    } : undefined;
    actions = visibleSources.map((source) => {
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
        const policy = overview.detail?.type === 'path' ? 'Path'
          : overview.detail?.refPolicy === 'explicit'
            ? `固定 ${sourceRefSummary(overview.detail.explicitRef ?? overview.detail.requestedRef)}`
            : `通道 ${sourceRefSummary(overview.detail?.requestedRef)}`;
        const version = `${generation?.active?.catalogVersion ?? '未启用'}${freshness?.candidate?.catalogVersion
          ? `→${freshness.candidate.catalogVersion}` : ''}`;
        const available = generation?.state === 'ready' || health === 'ready';
        const unavailable = health === 'unavailable' || health === 'error' || health === 'recovery';
        return {
          actionId: `source:${source.id}`,
          label: source.id,
          description: sourceLocationSummary(overview.detail?.type ?? 'git', overview.detail?.locationSummary),
          sourceLabel: policy,
          meta: `当前 ${version} · ${source.count === undefined ? '插件数未知' : `${source.count} 个插件`} · ${relativeCheckTime(freshness?.checkedAt)}`,
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
    bottomActions = [
      { label: '＋ 添加来源', description: 'Git 仓库或本地目录', run: beginAddSource },
      {
        actionId: 'source-check-all', label: '检查全部来源 [r]',
        description: '并行检查各来源；必要时完整验证；结果不会自动启用待检查版本',
        run: () => props.controller.recheckAllCatalogSources(),
      },
      { label: 'Catalog 本地存储', description: '检查占用和预览安全清理', run: () => go({ name: 'catalogStoreOverview' }) },
    ];
    help = '↑↓ 移动 · Enter 打开 · Esc 返回';
    const sourceCount = actions.length;
    actions = [...actions, ...bottomActions];
    content = <Box flexDirection="column">
      <QueryHeader width={size.columns - 2}
        tabs={hasTypeTabs ? { label: '类型', currentId: sourceType, items: [
          { id: 'all', label: '全部', count: matchingSources(props.controller, query, 'all').length },
          { id: 'git', label: 'Git', count: matchingSources(props.controller, query, 'git').length },
          { id: 'path', label: '本地', count: matchingSources(props.controller, query, 'path').length },
        ] } : undefined}
        search={{ value: query, placeholder: '名称或地址', input: searchFocus
          ? <InputDisplay value={query} cursor={searchCursor} columns={querySearchWidth(size.columns - 2)} /> : undefined }} />
      {sourceCount === 0 && allSources.length > 0
        ? <Text color={tuiTheme.roles.secondary}>当前条件无匹配；搜索和类型保持原样。</Text> : null}
      <SequenceRows actions={actions} itemCount={sourceCount} focus={focus}
        scrollOffset={scrollOffset} columns={size.columns - 2}
        rowBudget={pageActionBudget(1 + Number(hasTypeTabs) + Number(sourceCount === 0 && allSources.length > 0))}
        compact={policy.mode === 'compact'} cards inactive={searchFocus} />
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
      { role: 'navigation' as const, actionId: 'catalog-store-back', label: '返回来源列表', run: back },
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
      { role: 'navigation' as const, actionId: 'catalog-store-rules-back', label: '返回存储概览', run: back },
    ];
    if (showTechnical) readingText = [
      '锁 · AW_HOME 写锁内重新检查',
      '正式目录版本 · 非 Active 项保留 30 天',
      'staging、replacement、delete claim · 保留 24 小时',
      'quarantine · 保留 24 小时；对应正式目录版本必须完整健康',
      '保留节点 · foreign、符号链接、unsafe、损坏或未知项目',
    ].join('\n');
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
      {readingText !== undefined
        ? readingPage(readingText, size.columns - 2, Math.max(1, pageActionBudget(5) - 1)) : null}
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
    const generationMissingCount = generation?.compatibility?.state === 'unsupported'
      ? generation.compatibility.missingCapabilities.length : undefined;
    const freshnessMissingCount = freshness?.missingCapabilities?.length;
    breadcrumb = `插件来源 / ${route.sourceId}`;
    context = detail?.type === 'path' ? '本地目录' : 'Git';
    title = route.sourceId;
    description = generationState === 'incompatible'
      ? generationMissingCount && generationMissingCount > 0
        ? `当前目录版本与 AW 不兼容；缺少 ${generationMissingCount} 项功能支持。`
        : '当前目录版本与 AW 不兼容；所需功能无法确认。'
      : freshness?.state === 'incompatible'
      ? generationState === 'repairRequired'
        ? `待检查版本需要升级 AW 或修改来源后才能使用；损坏的当前启用版本仍可按旧版本精确修复。`
        : activeVersion && generationState === 'ready'
        ? freshnessMissingCount && freshnessMissingCount > 0
          ? `当前 AW 缺少 ${freshnessMissingCount} 项待检查版本所需功能；当前目录版本 ${activeVersion} 仍可浏览和使用。`
          : `待检查版本所需功能无法确认；已验证的当前目录版本 ${activeVersion} 仍可浏览和使用。`
        : freshnessMissingCount && freshnessMissingCount > 0
          ? `当前 AW 缺少 ${freshnessMissingCount} 项待检查版本所需功能；这个来源没有已验证可用的目录版本。`
          : '待检查版本所需功能无法确认；这个来源没有已验证可用的目录版本。'
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
          : logicalIdentityChanged ? '来源发布身份已变化；旧 Active 是否仍可用需要单独验证。请编辑来源，或移除后重新添加。'
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
              status: 'info',
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
                label: freshness?.state === 'checking' ? '正在检查' : '检查来源 [r]',
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
      ...(freshness?.operationRecordId ? [{
        actionId: 'source-check-diagnostic',
        label: '查看检查诊断与报告',
        description: `安全记录 ${freshness.operationRecordId}`,
        run: () => go({ name: 'operationDiagnostic', recordId: freshness.operationRecordId! }),
      }] : []),
      ...(generationState !== 'ready'
        || freshness?.state === 'updateAvailable'
        || freshness?.state === 'localChangesAvailable'
        || freshness?.state === 'versionConflict'
        || freshness?.state === 'rollbackDetected'
        || freshness?.state === 'incompatible' ? [{
        actionId: 'source-check',
        label: freshness?.state === 'checking' ? '正在检查' : '检查来源 [r]',
        description: '检查这个来源；检测到变化或异常时完整验证',
        disabled: freshness?.state === 'checking' ? '检查正在进行' : undefined,
        run: () => props.controller.recheckCatalogSource(route.sourceId),
      }] : []),
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
    const versionPolicy = detail?.type === 'path' ? 'Path · 当前本地内容'
      : detail?.refPolicy === 'cliChannel' ? `跟随 AW 通道 · ${sourceRefSummary(detail.requestedRef)}`
        : `固定 ref · ${sourceRefSummary(detail?.explicitRef ?? detail?.requestedRef)}`;
    const sourceCount = snapshot.viewModel?.sourceTabs.find((source) => source.id === route.sourceId)?.count;
    const checkAction: ActionItem = {
      actionId: 'source-check',
      label: freshness?.state === 'checking' ? '正在检查' : '检查来源 [r]',
      description: '检查这个来源；检测到变化或异常时完整验证；不会自动启用更新',
      disabled: freshness?.state === 'checking' ? '检查正在进行' : undefined,
      run: () => props.controller.recheckCatalogSource(route.sourceId),
    };
    const viewPluginsAction: ActionItem = {
        actionId: 'source-view-plugins',
        label: '查看此来源插件',
        description: sourceCount === undefined ? '插件数未知' : `${sourceCount} 个插件`,
        run: () => go({ name: 'pluginList', mode: 'browse', sourceId: route.sourceId }),
      };
    const healthyWithoutUpdate = generationState === 'ready'
      && (freshness?.state === 'current' || freshness?.state === 'fixed');
    actions = [
      ...(healthyWithoutUpdate ? [viewPluginsAction] : []),
      ...sourcePrimaryAction,
      ...(sourcePrimaryAction.some((action) => action.actionId === 'source-check')
        ? [] : [checkAction]),
      ...(healthyWithoutUpdate ? [] : [viewPluginsAction]),
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
    const sourceFacts: SourceDetailFacts = {
      sourceId: route.sourceId, primary: detail?.primary ?? false,
      address: sourceLocationSummary(detail?.type ?? 'git', detail?.locationSummary),
      transport, versionPolicy, currentVersion: activeVersion, candidateVersion,
      pluginCount: sourceCount,
      state: { label: sourceStateLabel, status: generationState === 'ready' ? 'success' : 'warning' },
      check: { label: freshnessLabel, time: relativeCheckTime(freshness?.checkedAt) },
    };
    title = '';
    context = '来源详情';
    if (generationState === 'ready' && freshness?.state !== 'checkFailed'
      && freshness?.state !== 'incompatible') description = undefined;
    actions.unshift({ actionId: 'source-information', label: '来源信息', run: () => setFocus(1) });
    const focusedSourceDescription = actions[focus]?.disabled ?? actions[focus]?.description;
    const sourceDescriptionLines = focusedSourceDescription
      ? wrapConsoleText(focusedSourceDescription, size.columns - 2) : [];
    const sourceActionDescriptionLines = sourceDescriptionLines;
    const cardWidth = size.columns - 2;
    const sourceLayout = sourceDetailCardLayout(sourceFacts, cardWidth);
    const lineLimit = Math.max(1, pageActionBudget(sourceActionDescriptionLines.length + 2) - 4);
    const lineOffset = Math.min(batchTargetOffset, Math.max(0, sourceLayout.factRows - lineLimit));
    entityCardNavigation = { itemCount: 1, factRows: [sourceLayout.factRows], lineLimit };
    const sourceCardHeight = entityCardWindowHeight(sourceLayout, lineOffset, lineLimit);
    currentActionViewportLineBudget = Math.max(1,
      pageActionBudget(sourceCardHeight + sourceActionDescriptionLines.length));
    const detailMenuViewport = actionViewport(actions, true, focus, scrollOffset,
      currentActionViewportLineBudget);
    help = focus === 0
      ? '↑↓ 浏览信息 · PgUp/PgDn 翻信息 · a 选择动作 · Enter 选择动作 · Esc 返回'
      : '↑↓ 选择动作 · a 查看信息 · Enter 选择 · Esc 返回';
    content = <Box flexDirection="column">
      <SourceDetailCard facts={sourceFacts} width={cardWidth} focused={focus === 0}
        lineOffset={lineOffset} lineLimit={lineLimit} />
      <SemanticRows actions={actions} focus={focus} kind="action" compact
        offset={Math.max(1, detailMenuViewport.offset)}
        limit={Math.max(0, detailMenuViewport.limit - Number(detailMenuViewport.offset === 0))} />
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
      { label: freshness?.state === 'checking' ? '正在检查' : '检查来源 [r]',
        description: '检查这个来源；检测到变化或异常时完整验证；不会自动启用更新',
        disabled: freshness?.state === 'checking' ? '检查正在进行' : undefined,
        run: () => props.controller.recheckCatalogSource(route.sourceId) },
      { label: '技术详情', description: '查看脱敏错误代码和版本证据',
        run: () => go({ name: 'sourceTechnical', sourceId: route.sourceId }) },
      ...(freshness?.operationRecordId ? [{
        label: '查看检查诊断与报告',
        description: `安全记录 ${freshness.operationRecordId}`,
        run: () => go({ name: 'operationDiagnostic', recordId: freshness.operationRecordId! }),
      }] : []),
    ];
    const viewport = actionViewport(actions, policy.mode === 'compact', focus, scrollOffset, pageActionBudget(1));
    content = <SemanticRows actions={actions} focus={focus} kind="action" compact={policy.mode === 'compact'} offset={viewport.offset} limit={viewport.limit} />;
  } else if (route.name === 'sourceTechnical') {
    const diagnostic = resolveSourceTechnicalDiagnostic(route.sourceId);
    readingText = diagnosticDetailText(diagnostic);
    breadcrumb = `插件来源 / ${route.sourceId} / 技术详情`;
    title = '来源技术诊断';
    description = '';
    help = '←→ 或 PgUp/PgDn 翻页 · Esc 返回';
    actions = [
      { label: '返回来源详情', run: back },
    ];
    content = <Box flexDirection="column">
      {readingPage(readingText, size.columns - 2, Math.max(1, pageActionBudget(4) - 1))}
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
        beginSourceReview(draft, false);
      } },
    ];
    content = <Box flexDirection="column"><SectionCard title="当前设置" compact={policy.mode === 'compact'}>
      <StaticRow title="来源类型" meta={(draft?.type ?? detail?.type) === 'git' ? 'Git 仓库' : '本地目录'} compact />
    </SectionCard><SemanticRows actions={actions} focus={sourceTransportOverlay ? -1 : focus} kind="section" compact={policy.mode === 'compact'} /></Box>;
  } else if (route.name === 'sourceSave' && sourceDraft?.owner === route.owner) {
    const changes = sourceDraftChanges(sourceDraft);
    if (route.view === 'changes') {
      readingText = changeDetailText(changes);
      const pageRows = Math.max(1, Math.min(
        responsiveBudget(5, 10),
        pageActionBudget(5) - 1,
      ));
      breadcrumb = `插件来源 / ${sourceDraft.sourceId} / 完整变化`;
      title = '完整来源变化';
      description = '逐项显示修改前和修改后的完整值。';
      help = '←→ 或 PgUp/PgDn 阅读 · ↑↓ 移动 · Enter 选择 · Esc 返回修改汇总';
      actions = [
        { label: '返回修改汇总', run: back },
      ];
      content = <Box flexDirection="column">
        {readingPage(readingText, size.columns - 2, pageRows)}
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
    } }, { role: 'navigation' as const, label: '返回来源详情', run: back }];
    const countLabel = (value: number | undefined, unit: string): string => value === undefined ? '未知' : `${value} ${unit}`;
    const referenceLimit = Math.max(1, pageActionBudget(12));
    const references = sourceReferenceSummary?.dependencies ?? [];
    if (sourceDependenciesExpanded) readingText = references.map((dependency) =>
      `${dependency.category} · ${dependency.pluginId ?? dependency.sourceId ?? '身份未知'} · ${dependency.platform ? platformLabel(dependency.platform) : ''}${dependency.scope ? ` · ${scopeLabel(dependency.scope)}` : ''}`).join('\n');
    const referencePage = pagedItems(references.length, referenceLimit);
    const visibleReferences = references.slice(referencePage.offset, referencePage.offset + referenceLimit);
    if (sourceDependenciesExpanded && references.length > referenceLimit) {
      referenceDetailPagination = { total: references.length, pageRows: referenceLimit };
      help = '←→ 查看全部引用 · ↑↓ 移动 · Enter 选择 · Esc 返回';
    }
    content = <Box flexDirection="column">
      <Callout status="error" title={sourceReferenceSummary?.inventoryComplete === false ? '引用清单不完整' : '发现活动引用'} />
      <SectionCard title={sourceDependenciesExpanded ? '引用内容' : '引用汇总'}>
        {!sourceDependenciesExpanded ? <>
          <StaticRow title="安装位置" meta={countLabel(sourceReferenceSummary?.installationCount, '个')} />
          <StaticRow title="插件设置" meta={countLabel(sourceReferenceSummary?.configCount, '份')} />
          <StaticRow title="生命周期意图" meta={countLabel(sourceReferenceSummary?.lifecycleCount, '项')} />
          <StaticRow title="Marketplace" meta={countLabel(sourceReferenceSummary?.marketplaceCount, '个')} />
        </> : null}
        {sourceDependenciesExpanded ? visibleReferences.map((dependency, index) => <StaticRow key={`${dependency.category}:${dependency.pluginId ?? dependency.sourceId ?? referencePage.offset + index}`} title={`${dependency.category} · ${dependency.pluginId ?? dependency.sourceId ?? '身份未知'}`} meta={`${dependency.platform ? platformLabel(dependency.platform) : ''}${dependency.scope ? ` · ${scopeLabel(dependency.scope)}` : ''}`} />) : null}
        {sourceDependenciesExpanded && referencePage.pageCount > 1
          ? <Pager page={referencePage.page} pageCount={referencePage.pageCount} columns={size.columns - 6} /> : null}
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
        { role: 'navigation', label: '返回首页', run: () => requestSessionNavigation('home') },
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
    const reminder = snapshot.projectIntentReminder;
    const pendingProjectTargets = (reminder?.actionableTargets.length ?? 0)
      + (reminder?.blockedTargets.length ?? 0) + (reminder?.unconfirmedTargets.length ?? 0);
    const projectDiagnostic = Boolean(snapshot.projectIntentIssue
      || reminder?.kind === 'recovery' && reminder.diagnosticCodes.length > 0
      || snapshot.projectInventory?.recovery?.inventory === null
      || snapshot.projectInventory?.recovery
        && !['valid', 'absent'].includes(snapshot.projectInventory.recovery.intent.state));
    if (projectDiagnostic || pendingProjectTargets > 0) {
      title = '需要处理';
      context = issues.length > 0 ? `${issues.length} 项 · 项目插件待处理` : '项目插件待处理';
      description = '查看项目插件、安装、来源或设置问题。';
      actions.unshift({ actionId: 'project-status', label: '项目插件',
        description: projectDiagnostic ? '项目声明或状态需要检查'
          : `${pendingProjectTargets} 个位置待处理或未确认`,
        status: 'warning', run: () => go({ name: 'projectStatus' }) });
    }
    const viewport = actionViewport(actions, policy.mode === 'compact', focus, scrollOffset, responsiveBudget(8, 12));
    if (issues.length === 0 || projectDiagnostic || pendingProjectTargets > 0) {
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
    const issueDetailRows = diagnosticDetailLines(issue.diagnostic, size.columns - 6).length;
    if (showTechnical) readingText = diagnosticDetailText(issue.diagnostic);
    const issueDetailPageRows = policy.mode === 'compact'
      ? 1
      : Math.max(1, responsiveBudget(1, 4));
    if (showTechnical && issueDetailRows > issueDetailPageRows) {
      referenceDetailPagination = { total: issueDetailRows, pageRows: issueDetailPageRows };
      help = '←→ 或 PgUp/PgDn 阅读全部技术字段 · ↑↓ 移动 · Enter 选择 · Esc 返回';
    }
    const issuePlugin = issue.pluginId ? props.controller.getPluginOverview(issue.pluginId) : undefined;
    const issueOverview = issue.pluginId ? props.controller.getPluginDependencyOverview(issue.pluginId) : undefined;
    const issueDiagnosticSummary = <DiagnosticSummary
      diagnostic={issue.diagnostic}
      columns={size.columns}
      technical={showTechnical}
      offset={showTechnical ? batchTargetOffset : undefined}
      limit={showTechnical ? issueDetailPageRows : undefined}
      compact={policy.mode === 'compact' || issue.category.startsWith('dependency')
        || issue.category === 'scopeConflict'}
    />;
    const issueActionViewport = actionViewport(actions, policy.mode === 'compact', focus, scrollOffset, pageActionBudget(6));
    if (showTechnical) {
      const technicalActionViewport = actionViewport(actions, true, focus, scrollOffset,
        pageActionBudget(issueDetailPageRows + 6));
      content = <Box flexDirection="column">
        {issueDiagnosticSummary}
        <SemanticRows actions={actions} focus={focus} kind="action" compact
          offset={technicalActionViewport.offset} limit={technicalActionViewport.limit} />
      </Box>;
    } else if (issue.category === 'dependencyStillRequired' && issuePlugin) {
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
        <SemanticRows actions={actions} focus={focus} kind="action" compact={policy.mode === 'compact'} />
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
          { role: 'navigation' as const, label: '返回上一页', run: back },
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
    context = '安全详情';
    title = detail ? '安全技术详情' : '操作记录已不可用';
    description = detail
      ? '可翻页查看所有目标、阶段、代码和已保留的安全原因。'
      : '这项会话记录已经不再可用。';
    const preview = detail ? props.controller.previewOperationReport(route.recordId) : undefined;
    const detailLineLimit = Math.max(1, pageActionBudget(policy.mode === 'compact' ? 1 : 5) - 1);
    if (detail) {
      readingText = operationDiagnosticText(detail);
    }
    actions = detail ? [
      preview
        ? { label: '预览安全报告', description: '确认内容后选择本地保存位置', run: () => go({ name: 'operationReportPreview', recordId: route.recordId }) }
        : { label: '报告当前不可用', disabled: '无法生成这项记录的报告' },
      { role: 'navigation' as const, label: '返回操作记录', run: back },
    ] : [{ role: 'navigation' as const, label: '返回操作记录', run: back }];
    const diagnosticActionViewport = actionViewport(actions, policy.mode === 'compact', focus, 0,
      policy.mode === 'compact' ? 2 : 3);
    content = detail && readingText !== undefined ? <Box flexDirection="column">
      {policy.mode === 'compact' ? null : <ResultCard status={operationHistoryState(detail.summary).status}
        title={detail.summary.message} meta={operationHistoryState(detail.summary).label} compact={false} />}
      <ContentViewport>{readingPage(readingText, size.columns - 2, detailLineLimit, 'scroll')}</ContentViewport>
      <SemanticRows actions={actions} focus={focus} kind="action" compact={policy.mode === 'compact'}
        offset={diagnosticActionViewport.offset} limit={diagnosticActionViewport.limit} />
    </Box> : <Box flexDirection="column">
      <Callout status="warning" title="记录已不可用" description="返回操作记录后可查看仍在本次会话中的结果。" />
      <SemanticRows actions={actions} focus={focus} kind="action" compact={policy.mode === 'compact'} />
    </Box>;
  } else if (route.name === 'operationReportPreview') {
    const preview = props.controller.previewOperationReport(route.recordId);
    breadcrumb = '操作记录 / 报告预览';
    context = '安全报告';
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
      readingText = preview.content;
      const reportFeedbackVisible = Boolean(reportSaveResult || reportSaveError);
      const reportLineLimit = Math.max(1, pageActionBudget(
        (policy.mode === 'compact' ? 2 : 8)
          + (reportFeedbackVisible ? 4 : 0)) - 1);
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
        { role: 'navigation' as const, label: '返回技术详情', run: back },
      ];
      const compactReportActions = policy.mode === 'compact' || reportFeedbackVisible;
      const reportActionLimit = policy.mode === 'compact' || reportFeedbackVisible ? 2 : 3;
      const reportActionOffset = Math.min(
        Math.max(0, focus - 1),
        Math.max(0, actions.length - reportActionLimit),
      );
      content = <Box flexDirection="column">
        {policy.mode === 'compact' ? null : <ResultCard status={preview.omitted ? 'warning' : 'info'}
          title="报告预览" description={preview.omitted ? '报告只包含已保留的安全内容。' : '报告只包含本页安全内容。'}
          meta={preview.fileName} compact={false} />}
        <ContentViewport>{readingPage(readingText, size.columns - 2, reportLineLimit, 'scroll')}</ContentViewport>
        {reportSaveResult ? <Callout status="success" title="报告已保存" description={reportSaveResult} compact={policy.mode === 'compact'} /> : null}
        {reportSaveError ? <Callout status="error" title="报告未保存" description={reportSaveError} compact={policy.mode === 'compact'} /> : null}
        <SemanticRows actions={actions} focus={focus} kind="action" compact={compactReportActions}
          offset={reportActionOffset} limit={reportActionLimit} />
      </Box>;
    } else {
      actions = [{ role: 'navigation' as const, label: '返回技术详情', run: back }];
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
    readingText = [
      ...(review.operationKind === 'pluginWriteTask' && splitTaskReview
        ? splitTaskLines(splitTaskReview) : []),
      `${review.title} · ${review.subject.name}`,
      review.description,
      ...(review.equivalentCommand && !review.requiresConfirmation
        ? [`等价命令：${review.equivalentCommand}`] : []),
      ...(review.rootSummary ?? []).map((root) =>
        `${root.pluginId}${root.version ? ` · ${root.version}` : ''} · ${root.targets.map((target) => `${target.platform}/${target.scope}`).join('、')}`),
      ...review.changes.map((change) =>
        `${change.sourceId ? `${change.sourceId} · ` : ''}${reviewSymbol(change)} ${change.title}${change.description ? ` · ${change.description}` : ''}`),
      ...(review.technicalDetails ?? []),
      ...(review.confirmationDetails ?? []),
      ...(review.sharedImpact.warning ? [review.sharedImpact.warning] : []),
    ].join('\n');
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
      ? review.title : review.title.startsWith('确认') ? review.title : `确认${review.title}`}${review.operationKind === 'catalogStorePrune' ? '' : ` ${review.subject.name}`}`;
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
    const configApplyBlocked = pendingReviewIntent?.kind === 'configSaveBatch' && pendingReviewIntent.apply
      && (review.configImpact?.state === 'unknown' || review.configImpact?.affectedTargetCount === 0);
    actions = [
      { label: review.primaryLabel, disabled: configApplyBlocked ? review.configImpact?.state === 'unknown'
        ? '应用影响未确认；请选择只保存或重新检查' : '没有应用目标；请选择只保存' : undefined, description: requiresIndependentConfirmation
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
      ...(sourceDraft && (pendingReviewIntent?.kind === 'sourceMutation' || pendingReviewIntent?.kind === 'catalogGeneration')
        && pendingReviewIntent.sourceId === sourceDraft.sourceId ? [{
          label: pendingReviewIntent.kind === 'catalogGeneration' ? '改为只保存' : '改为保存并启用',
          run: () => {
            const activate = pendingReviewIntent.kind !== 'catalogGeneration';
            back();
            beginSourceReview(sourceDraft, activate);
          },
        }] : []),
      ...(pendingReviewIntent?.kind === 'configSaveBatch' && (pendingReviewIntent.apply
        || review.configImpact?.state === 'known' && review.configImpact.affectedTargetCount > 0) ? [{
        label: pendingReviewIntent.apply ? '改为只保存，稍后应用' : '改为保存并生效',
        description: '重新检查影响；此选择不写入配置',
        run: () => {
          const intent = { ...pendingReviewIntent, apply: !pendingReviewIntent.apply };
          back();
          beginReview(intent);
        },
      }] : []),
      ...(pendingReviewIntent?.kind === 'configSaveBatch' && review.configImpact?.state === 'unknown' ? [{
        label: '重新检查应用影响', run: () => { const intent = pendingReviewIntent; back(); beginReview(intent); },
      }] : []),
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
    const batchChangePage = paginateWrappedRows({
      lines: userReviewChanges.map((_, index) => String(index)), rows: batchChangeLimit,
      page: batchTargetOffset + 1,
    });
    const batchChanges = userReviewChanges.slice(batchChangePage.offset,
      batchChangePage.offset + batchChangeLimit);
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
    const pagedReviewChanges = prioritizedReviewChanges.slice(batchChangePage.offset,
      batchChangePage.offset + batchChangeLimit);
    const changeGroups = portableReview || batchReview || userReviewChanges.length > staticRowBudget
      ? <Box flexDirection="column">
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
        </Box>
      : standardChangeGroups;
    const technicalDetailLimit = responsiveBudget(1, 1);
    const technicalCardRows = 3 + Math.min(technicalDetails.length, technicalDetailLimit);
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
    const technicalChangePageCount = Math.ceil(prioritizedTechnicalChanges.length / technicalChangeBudget);
    const technicalDetailPageCount = Math.ceil(technicalDetails.length / technicalDetailLimit);
    const reviewPageCount = showTechnical
      ? Math.max(1, technicalChangePageCount + technicalDetailPageCount)
      : portableReview || batchReview || userReviewChanges.length > staticRowBudget
        ? batchChangePage.pageCount : 1;
    const reviewCurrentPage = Math.min(reviewPageCount, batchTargetOffset + 1);
    const technicalChangePage = paginateWrappedRows({
      lines: prioritizedTechnicalChanges.map((_, index) => String(index)),
      rows: technicalChangeBudget, page: reviewCurrentPage,
    });
    const technicalDetailPage = paginateWrappedRows({
      lines: technicalDetails, rows: technicalDetailLimit,
      page: Math.max(1, reviewCurrentPage - technicalChangePageCount),
    });
    const visibleTechnicalDetails = reviewCurrentPage > technicalChangePageCount
      ? technicalDetailPage.lines : [];
    const hiddenTechnicalDetails = Math.max(0,
      technicalDetails.length - technicalDetailPage.offset - visibleTechnicalDetails.length);
    const visibleTechnicalChanges = reviewCurrentPage <= technicalChangePageCount
      ? prioritizedTechnicalChanges.slice(technicalChangePage.offset,
          technicalChangePage.offset + technicalChangeBudget) : [];
    const hiddenTechnicalChanges = Math.max(0,
      review.changes.length - technicalChangePage.offset - visibleTechnicalChanges.length);
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
    const reviewRootPluginIds = taskReview || batchReview
      ? review.rootSummary?.map((root) => root.pluginId) ?? [] : [];
    const reviewRootSummary = reviewRootPluginIds.length === 1
      ? props.controller.getPluginOverview(reviewRootPluginIds[0]!)?.displayName
        ?? reviewRootPluginIds[0]!.split('/').at(-1)!
      : reviewRootPluginIds.length > 1 ? `${reviewRootPluginIds.length} 个` : undefined;
    const reviewVersionSummary = review.rootSummary && review.rootSummary.length > 0
      ? [...new Set(review.rootSummary.map((root) => root.version ?? '未知'))].join('、')
      : undefined;
    const reviewRangeSummary = review.rootSummary && review.rootSummary.length > 0
      ? [...new Set(review.rootSummary.flatMap((root) => root.targets.map((target) =>
          `${target.platform === 'both' ? 'Codex/Claude Code' : platformLabel(target.platform)}/${scopeLabel(target.scope)}`)))].join('、')
      : undefined;
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
    if (reviewPageCount > 1) {
      readerNavigation = {
        page: reviewCurrentPage,
        pageCount: reviewPageCount,
        move: (direction) => setBatchTargetOffset(Math.min(reviewPageCount,
          Math.max(1, reviewCurrentPage + direction)) - 1),
      };
      help = 'PgUp/PgDn 查看全部确认信息 · ↑↓ 移动 · Enter 选择 · Esc 返回';
    }
    content = <Box flexDirection="column"><ReviewCard title={reviewRootSummary ? `本次插件 · ${reviewRootSummary}` : review.subject.name} meta={reviewRootSummary ? `版本 ${reviewVersionSummary} · 范围 ${reviewRangeSummary || '未知'}` : `${review.subject.sourceLabel ?? ''} ${review.subject.version ?? ''}`} description={showEquivalentCommand ? review.description : undefined}>{review.operationKind === 'pluginWriteTask' && splitTaskReview ? <StaticRow title={`完整请求 ${splitTaskReview.targets.length} 个位置 · 本次${scopeLabel(splitTaskReview.currentScope)} ${splitTaskReview.targets.filter((target) => target.scope === splitTaskReview.currentScope).length} 个`} description={`其余${scopeLabel(splitTaskReview.currentScope === 'user' ? 'project' : 'user')}位置需另行确认；y 复制完整请求`} status="warning" compact /> : null}{showEquivalentCommand ? <Text>等价命令：{review.equivalentCommand}</Text> : null}{portableReview ? <SemanticRows actions={actions} focus={operationConfirmation ? -1 : focus} kind="action" compact offset={reviewActionViewport.offset} limit={reviewActionViewport.limit} /> : null}{showTechnical && review.catalogBinding ? <><StaticRow title={`Catalog：${review.catalogBinding.sourceId} ${review.catalogBinding.catalogVersion} · 当前使用`} meta={`generation ${review.catalogBinding.generationDigestShort}`} status="success" compact /><StaticRow title="操作期间不检查远端 Catalog" status="success" compact /></> : null}{installDependencyPluginIds.size > 0 ? <><StaticRow
      title={`需要 ${installDependencyPluginIds.size} 个额外插件；${reusedDependencyPluginIds.size} 个复用、${newDependencyCount} 个新增`}
      status="info" compact /><StaticRow
      title={widenedDependencyCount > 0 ? `${widenedDependencyCount} 个依赖会扩大到所有项目` : '没有依赖会扩大到所有项目'}
      status={widenedDependencyCount > 0 ? 'warning' : 'success'} compact /></> : null}{review.requiresConfirmation ? <StaticRow title={review.operationKind === 'catalogStorePrune' ? '! 需要确认删除本次预览的可回收项目' : projectPreApplyConfirmation ? '! 需要确认当前项目同步脚本' : '! 需要确认会影响其他项目的内容'} meta={review.sharedImpact.pluginIds.length > 0 ? `${review.sharedImpact.pluginIds.length} 个插件` : undefined} description={review.sharedImpact.warning} status="warning" compact /> : null}{showTechnical ? technicalChanges : changeGroups}{showTechnical && visibleTechnicalDetails.length > 0 ? <TechnicalDetails>{visibleTechnicalDetails.map((detail, index) => <StaticRow key={`${technicalDetailPage.offset + index}:${detail}`} title={detail} meta={catalogReferenceDetailOffset >= 0 && technicalDetailPage.offset + index >= catalogReferenceDetailOffset ? undefined : index === visibleTechnicalDetails.length - 1 && hiddenTechnicalDetails > 0 ? `另有 ${hiddenTechnicalDetails} 项` : undefined} compact />)}</TechnicalDetails> : null}{reviewPageCount > 1 ? <Pager page={reviewCurrentPage} pageCount={reviewPageCount} columns={size.columns - 6} /> : null}{portableReview ? null : <SemanticRows actions={actions} focus={operationConfirmation ? -1 : focus} kind="action" compact offset={reviewActionViewport.offset} limit={reviewActionViewport.limit} />}{compressedReview || showTechnical ? null : <StaticRow title="技术详情（d）" status="muted" />}</ReviewCard></Box>;
    if (pendingReviewIntent?.kind === 'configSaveBatch' || sourceDraft && (pendingReviewIntent?.kind === 'sourceMutation' || pendingReviewIntent?.kind === 'catalogGeneration') && pendingReviewIntent.sourceId === sourceDraft.sourceId) {
      const changesText = pendingReviewIntent.kind === 'configSaveBatch' ? pendingReviewIntent.groups.map((group) =>
        `${configLayerLabel({ scope: group.scope })}\n${(group.changes ?? []).flatMap((change) => [
          `${change.title} · ${change.before ?? '未设置'} → ${change.after}${change.children?.length ? ` · ${change.children.length} 个子属性变化` : ''}`,
          ...(change.children ?? []).map((child) => `${child.property} · ${child.before} → ${child.after}`),
        ]).join('\n')}`).join('\n') : changeDetailText(sourceDraftChanges(sourceDraft!));
      const impact = review.changes.filter((change) => change.group !== 'configChanges')
        .map((change) => `${reviewSymbol(change)} ${change.title}${change.description ? ` · ${change.description}` : ''}`);
      readingText = pendingReviewIntent.kind === 'configSaveBatch'
        ? [changesText, ...new Set([...impact, ...(review.technicalDetails ?? []), ...(review.confirmationDetails ?? []),
            ...(review.sharedImpact.warning ? [review.sharedImpact.warning] : [])])].join('\n')
        : `${changesText}\n\n${readingText}`;
      if (pendingReviewIntent.kind === 'configSaveBatch') description = pendingReviewIntent.apply ? '保存并生效；每层独立提交，应用结果单独报告。' : '只保存；每层独立提交，稍后应用。';
      const pageRows = Math.max(1, pageActionBudget(actions.length + 1) - 1);
      content = <Box flexDirection="column">
        {readingPage(readingText, size.columns - 2, pageRows)}
        <SemanticRows actions={actions} focus={operationConfirmation ? -1 : focus} kind="action" compact />
      </Box>;
    }
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
    readingText = [
      title,
      ...prioritizedProgressTargets.map((entry) =>
        `${entry.pluginId} · ${platformLabel(entry.platform)} · ${scopeLabel(entry.scope)} · ${progressLabel(entry).label}`),
      ...snapshot.progress.messages.map(productResultMessage),
    ].join('\n');
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
      ? '←→ 翻页 · [y] 复制全文 · Ctrl-C 完成后退出'
      : '[y] 复制全文 · Ctrl-C 完成后退出';
    if (copyFeedback?.routeKey === routeKey) description = copyFeedback.message;
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
      <ProgressRow title={`安装已选择的 ${portableSelectedCount} 个 Skills`} description={`Agent：${portableDraft?.agentMode === 'explicit' ? portableDraft.requestedAgents.join('、') : '自动选择可用 Agent'}`} meta={portableProgressMeta(2)} state={portableProgressState(2)} compact={compactPortableProgress} />
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
    if (taskOperation && splitTaskReview?.currentScope === 'user') {
      if (!blocked && !partial) title = '✓ 所有项目范围已处理';
      description += ` 当前项目的 ${splitTaskReview.targets.filter((target) => target.scope === 'project').length} 个位置尚未处理。`;
    }
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
    const sourceRecoveryRoute = 'returnRoute' in result && result.returnRoute?.name === 'sourceDetail'
      ? result.returnRoute : undefined;
    const resumeConfigSourceDraft = operationKind === 'catalogGeneration'
      && sourceRecoveryRoute !== undefined
      && dirty
      && draftOwner?.startsWith(`${sourceRecoveryRoute.sourceId}/`)
      && props.controller.externalDrafts.some((draft) =>
        draft.kind === 'configDraft' && draft.owner === draftOwner);
    actions = storeOperation
      ? [
          { role: 'navigation', label: '返回存储概览', run: () => leaveResult({ name: 'catalogStoreOverview' }) },
          { label: '查看本次记录', run: () => {
            if (result.operationRecordId) go({ name: 'operationDiagnostic', recordId: result.operationRecordId });
          } },
        ]
      : taskOperation
      ? [
          ...(splitTaskReview?.currentScope === 'user'
            && splitTaskReview.targets.some((target) => target.scope === 'project') ? [{
            label: `继续处理当前项目 ${splitTaskReview.targets.filter((target) => target.scope === 'project').length} 个位置`,
            description: '重新准备项目范围并显示独立 Review',
            run: () => {
              const context = splitTaskReview;
              leaveResult(context.returnRoute);
              startSplitTaskScope(context, 'project');
            },
          }] : []),
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
          ...(!nestedTaskReturn ? [{ role: result.state === 'succeeded' ? 'navigation' as const : undefined,
            label: '完成，返回我的插件', run: () => {
            if (taskBatchOrigin?.owner === 'batch-write'
              && taskBatchOrigin.flowId === batchDraft?.flowId) {
              setBatchDraft(undefined);
              setDirty(false);
            }
            leaveResult({ name: 'pluginList', mode: 'installed' });
          } }] : []),
          { label: '查看本次记录', run: () => {
            if (result.operationRecordId) go({ name: 'operationDiagnostic', recordId: result.operationRecordId });
          } },
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
          { role: result.state === 'succeeded' ? 'navigation' : undefined,
            label: '返回我的插件', run: () => leaveResult() },
          { label: '查看本次记录', run: () => {
            if (result.operationRecordId) go({ name: 'operationDiagnostic', recordId: result.operationRecordId });
          } },
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
          { role: 'navigation' as const, label: portableReturnLabel, run: () => {
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
            { role: 'navigation', label: '查看问题列表', run: () => leaveResult({ name: 'issueList' }) },
            { role: 'navigation', label: '返回首页', run: () => requestSessionNavigation('home') },
          ]
      : sourceOperation
      ? [{
          label: !blocked && 'returnRoute' in result && result.returnRoute?.name === 'pluginWriteTask'
            ? '重新准备插件更新' : blocked ? '返回修改' : partial ? '现在启用 / 重试'
              : resumeConfigSourceDraft ? '继续编辑未保存设置' : '查看来源',
          role: !blocked && !partial && !resumeConfigSourceDraft
            && !('returnRoute' in result && result.returnRoute?.name === 'pluginWriteTask')
            ? 'navigation' : undefined,
          run: () => blocked ? props.controller.resumeResultDraft() : leaveResult(),
        }, { role: !blocked && !partial ? 'navigation' : undefined,
          label: '返回首页', run: () => requestSessionNavigation('home') }]
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
      : [{ role: !partial && !blocked && !blockedDependencyFailure ? 'navigation' : undefined,
        label: partial || blockedDependencyFailure ? '查看失败项' : successfulConfigOperation && configOrigin
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
    }] : []), { role: !partial && !blocked ? 'navigation' : undefined,
      label: '返回首页', run: () => requestSessionNavigation('home') }];
    if (snapshot.canResumeInstallDraft) {
      actions.unshift({ label: '返回修改', run: async () => {
        props.controller.resumeResultDraft();
        if (props.controller.snapshot.router.current.route.name === 'dependencyPlacement') {
          await props.controller.prepareInstallDependencyPlacement();
        }
        setFocus(0);
        setScrollOffset(0);
      } });
    }
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
    const portableSkillPage = pagedItems(prioritizedPortablePairs.length, portableSkillLimit);
    const portableSkillOffset = portableSkillPage.offset;
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
    readingText = portableResultDetailOpen ? selectedPortablePair ? [
      `Skill · ${selectedPortablePair.skill}`,
      `Agent · ${selectedPortablePair.agent ?? '无法确认'}`,
      `状态 · ${portablePairStateLabel(selectedPortablePair)}`,
      ...(portableResultScope ? [`范围 · ${scopeLabel(portableResultScope)}`] : []),
      ...(portableReceipt?.recovery ? [`安全恢复 · ${portableReceipt.recovery}`] : []),
      ...(portableReceipt?.failureCode ? [`failure code · ${portableReceipt.failureCode}`] : []),
      ...(portableReceipt ? [`verification missing · ${portableReceipt.missing.length}`,
        `Skills CLI version · ${portableReceipt.skillsCliVersion}`,
        `materialization digest · ${portableReceipt.materializationDigest}`] : []),
      ...(resultSummary?.elapsedMs !== undefined ? [`elapsed · ${resultSummary.elapsedMs} ms`] : []),
    ].join('\n') : '当前结果已变化。请返回结果摘要。' : [
      ...(taskOperation && splitTaskReview ? splitTaskLines(splitTaskReview) : []),
      resultSummary?.message ?? (blocked ? result.message : '操作结果'),
      ...(resultSummary?.messages ?? []).map(productResultMessage),
      ...(resultSummary?.changes ?? []),
      ...(resultSummary?.warnings ?? []),
      ...(resultSummary?.recoveryActions ?? []),
      ...prioritizedTargets.map((target) =>
        `${resultTargetName(target)} · ${platformLabel(target.platform)} · ${scopeLabel(target.scope)} · ${operationTargetStateLabel(target.state).label}`),
      ...prioritizedPortablePairs.map((pair) =>
        `${pair.skill} · ${pair.agent ?? 'Agent 未确认'} · ${portablePairStateLabel(pair)}`),
      ...(taskSummary?.rootResults ?? []).map((root) => `${root.pluginId} · ${root.state}`),
      ...(resultSummary?.batch?.rootResults ?? []).map((root) => `${root.pluginId} · ${root.state}`),
    ].join('\n');
    const portableResultDetailPageRows = responsiveBudget(5, 10);
    const portableDetailPage = readerPage({ text: readingText, columns: size.columns - 2,
      rows: portableResultDetailPageRows, page: portableResultDetailOffset + 1 });
    if (portableOperation && portableResultDetailOpen) {
      title = '当前结果完整字段';
      description = '按行显示当前 Skill、Agent、状态和技术证据。';
      help = '←→ 阅读全部字段 · ↑↓ 移动 · Enter 选择 · Esc 返回结果摘要';
      actions = [
        { label: '返回结果摘要', run: () => {
          setPortableResultDetailOpen(false);
          setPortableResultDetailOffset(0);
          setFocus(portableResultDetailReturnFocus.current);
          setScrollOffset(0);
        } },
      ];
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
      actions = [
        ...actions.slice(0, 1),
        ...(detailAction ? [detailAction] : []),
        ...actions.slice(1),
      ];
    }
    const portableTechnicalFieldCount = portableReceipt
      ? 3 + (portableReceipt.failureCode ? 1 : 0)
          + (policy.mode === 'compact' ? 0 : resultSummary?.elapsedMs !== undefined ? 1 : 0)
      : 1;
    const portableFixedRows = (portableRecheckBusy ? 1 : 0) + (showTechnical
      ? 1 + portableSkillLimit + (portableResultScope && policy.mode !== 'compact' ? 1 : 0)
        + (portableResultAgentMode === 'automatic' && policy.mode !== 'compact' ? 1 : 0)
        + (portableReceipt?.recovery ? 1 : 0)
        + (policy.mode === 'compact' ? 0 : 1) + portableTechnicalFieldCount
      : 3 + portableSkillLimit + 1
        + (portableResultAgentMode === 'automatic' ? 1 : 0)
        + (portableReceipt?.recovery ? 1 : 0));
    currentActionViewportLineBudget = pageActionBudget(portableOperation
      ? portableResultDetailOpen
        ? portableDetailPage.lines.length + 1
        : portableFixedRows
      : resultPaginationTotal > 1 ? 7 : 8);
    const resultActionViewport = actionViewport(actions, true, focus, scrollOffset,
      currentActionViewportLineBudget);
    const resultTargetLimit = Math.max(1, prefixRowLimit(
      prioritizedTargets.map(() => policy.mode === 'compact' ? 1 : 2),
      pageActionBudget() - 3 - resultActionViewport.limit - resultExtraRows,
    ));
    const resultTargetPage = pagedItems(prioritizedTargets.length, resultTargetLimit);
    const resultTargetOffset = resultTargetPage.offset;
    const visibleResultTargets = prioritizedTargets.slice(
      resultTargetOffset,
      resultTargetOffset + resultTargetLimit,
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
    const taskLocationItems = taskRootResults.flatMap((root) => {
      return root.targets.map((target) => {
          const targetPluginId = target.pluginId ?? root.pluginId;
          const key = [targetPluginId, target.platform, target.scope].join('\0');
          const blockedTarget = blockedTaskTargets.get(key);
          const targetState = blockedTarget ? { label: '待确认', status: 'warning' as const }
            : target.state === 'completed' ? { label: '完成', status: 'success' as const }
              : target.state === 'kept' ? { label: '无需更改', status: 'success' as const }
                : target.state === 'failed' ? { label: '失败', status: 'error' as const }
                  : { label: '未开始', status: 'muted' as const };
          const relation = target.relation === 'direct' ? '直接依赖'
            : target.relation === 'transitive' ? '间接依赖' : '所选插件位置';
          return {
            key: `target:${root.pluginId}:${key}`,
            title: `${root.pluginId}${targetPluginId === root.pluginId ? '' : ` → ${targetPluginId}`} · ${platformLabel(target.platform)} · ${scopeLabel(target.scope)}`,
            description: blockedTarget
              ? pluginWriteTaskBlockLabel(blockedTarget.reason)
              : `${relation}${target.errorCode ? ` · ${target.errorCode}` : ''}`,
            meta: `${targetState.label}${target.errorCode ? ` · ${target.errorCode}` : ''}`,
            status: targetState.status,
            compact: !blockedTarget,
          };
        });
    });
    const taskLocationRows = taskLocationItems.map(({ key, ...item }) => <ResultRow key={key} {...item} />);
    if (taskOperation) readingText = [
      resultSummary?.message ?? (blocked ? result.message : '操作结果'),
      ...(resultSummary?.messages ?? []).map(productResultMessage),
      ...(resultSummary?.changes ?? []),
      ...(resultSummary?.warnings ?? []),
      ...(resultSummary?.recoveryActions ?? []),
      ...taskRootResults.map((root) => `${root.pluginId} · ${taskRootState(root.state).label}`),
      ...taskLocationItems.flatMap((item) => [`${item.title} · ${item.meta}`, item.description]),
    ].join('\n');
    const batchPluginResultRows = (resultSummary?.batch?.rootResults ?? []).map((root) => {
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
    });
    const batchLocationResultRows = prioritizedTargets.map((target) => {
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
    });
    const taskResultLimit = Math.max(1, pageActionBudget(5) - resultActionViewport.limit);
    const pluginResultRows = taskOperation ? taskSelectedPluginRows : batchPluginResultRows;
    const locationResultRows = taskOperation ? taskLocationRows : batchLocationResultRows;
    const combinedResultRows = [...pluginResultRows, ...locationResultRows];
    const actualResultRows = taskOperation || batchOperation ? combinedResultRows.length
      : portableOperation ? prioritizedPortablePairs.length : prioritizedTargets.length;
    const actualResultPageRows = taskOperation || batchOperation ? taskResultLimit
      : portableOperation ? portableSkillLimit : resultTargetLimit;
    if (!portableResultDetailOpen && actualResultRows > actualResultPageRows) {
      referenceDetailPagination = { total: actualResultRows, pageRows: actualResultPageRows };
    }
    const taskResultPage = pagedItems(combinedResultRows.length, taskResultLimit);
    const taskResultOffset = taskResultPage.offset;
    const visiblePluginResultRows = taskResultOffset < pluginResultRows.length
      ? pluginResultRows.slice(taskResultOffset, taskResultOffset + taskResultLimit) : [];
    const visibleLocationStart = Math.max(0, taskResultOffset - pluginResultRows.length);
    const remainingResultRows = taskResultLimit - visiblePluginResultRows.length;
    const visibleLocationResultRows = locationResultRows.slice(
      visibleLocationStart,
      visibleLocationStart + remainingResultRows,
    );
    if (taskOperation || batchOperation || resultTargets.length > resultTargetLimit
      || prioritizedPortablePairs.length > portableSkillLimit) {
      help = '←→ 查看全部项目 · ↑↓ 移动 · Enter 选择 · Esc 返回';
    }
    content = taskOperation || batchOperation ? <Box flexDirection="column">
      {visiblePluginResultRows.length > 0 ? <ResultCard status={resultStatus} title="插件结果" meta={`${pluginResultRows.length} 个插件`}>
        {visiblePluginResultRows}
      </ResultCard> : null}
      {visibleLocationResultRows.length > 0 ? <ResultCard status={resultStatus} title="使用位置与所需插件" meta={`${locationResultRows.length} 项`}>
        {visibleLocationResultRows}
      </ResultCard> : null}
      {taskResultPage.pageCount > 1
        ? <Pager page={taskResultPage.page} pageCount={taskResultPage.pageCount} columns={size.columns - 2} /> : null}
      <SemanticRows actions={actions} focus={focus} kind="action" compact offset={resultActionViewport.offset} limit={resultActionViewport.limit} />
    </Box> : portableOperation ? <Box flexDirection="column">
      {portableRecheckBusy
        ? <ProgressRow title="正在重新检查结果" description="只读取 Skills CLI 当前状态，不执行安装"
            state="active" compact={policy.mode === 'compact'} />
        : null}
      {portableResultDetailOpen ? <>
        {readingPage(readingText, size.columns - 2, portableResultDetailPageRows, 'portable')}
      </> : portableTechnicalSummary ? <>
        <StaticRow
          title={blocked ? '安装未开始或结果未确认' : partial ? '部分 Skills 未确认' : '通用 Skills 安装结果'}
          meta={portableResultScope && policy.mode === 'compact'
            ? `${portableResultRange ?? ''} · ${scopeLabel(portableResultScope)}` : portableResultRange}
          status={resultStatus}
          compact
        />
        {portableRows}
        {portableResultScope && policy.mode !== 'compact'
          ? <StaticRow title="范围" meta={scopeLabel(portableResultScope)} compact /> : null}
        {portableResultAgentMode === 'automatic' && policy.mode !== 'compact'
          ? <StaticRow title="Agent" meta="自动选择可用 Agent" compact /> : null}
        {portableReceipt?.recovery ? <StaticRow title={`安全恢复：${portableReceipt.recovery}`} status="warning" compact /> : null}
        {policy.mode === 'compact' ? null : <StaticRow title="技术详情" status="muted" compact />}
        {portableTechnicalRows}
      </> : <>
      <ResultCard status={resultStatus} title={blocked ? '安装未开始或结果未确认' : partial ? '部分 Skills 未确认' : '通用 Skills 安装结果'}
        meta={portableResultRange}>
      {portableRows}
        {portableResultScope ? <StaticRow title="范围" meta={scopeLabel(portableResultScope)} compact /> : null}
        {portableResultAgentMode === 'automatic'
          ? <StaticRow title="Agent" meta="自动选择可用 Agent" compact /> : null}
        {portableReceipt?.recovery
          ? <StaticRow title={`安全恢复：${portableReceipt.recovery}`} status="warning" compact />
          : null}
      </ResultCard>
      </>}
      {!portableResultDetailOpen && portableSkillPage.pageCount > 1
        ? <Pager page={portableSkillPage.page} pageCount={portableSkillPage.pageCount} columns={size.columns - 2} /> : null}
      <SemanticRows actions={actions} focus={focus} kind="action" compact offset={resultActionViewport.offset} limit={resultActionViewport.limit} />
    </Box> : <Box flexDirection="column"><ResultCard status={resultStatus} title={blockedDependencyFailure ? '依赖安装没有完成' : blocked ? result.writeMayHaveCompleted ? '结果未确认' : '操作未完成' : sourceOperation ? '来源配置写入已完成' : dependencyTargets ? partial ? '依赖安装没有全部完成' : '操作已完成' : resultSummary?.message ?? '状态已变化，请重新确认'} meta={resultTargets.length > 0 ? `${resultTargets.length} 个目标` : undefined}>{resetDispositionText ? <StaticRow title={resetDispositionText} status="success" compact /> : null}{configGroupRows}{visibleResultTargets.map((target) => { const state = operationTargetStateLabel(target.state); const relation = target.relation === 'requested' ? '你选择的插件' : target.relation === 'direct' ? '直接依赖' : target.relation === 'transitive' ? '间接依赖' : undefined; return <ResultRow key={`${target.pluginId ?? ''}:${target.platform}:${target.scope}`} title={resultTargetName(target)} description={relation} meta={state.label} status={state.status ?? 'muted'} compact={policy.mode === 'compact'} />; })}{resultTargetPage.pageCount > 1 ? <Pager page={resultTargetPage.page} pageCount={resultTargetPage.pageCount} columns={size.columns - 6} /> : null}{partial && hasPreservedTarget && resultTargets.some((target) => target.state === 'skipped') ? <StaticRow title="未执行的目标没有写入；已完成或已保留的目标保持可用。" status="muted" compact /> : null}{configOperation && partial && !invalidConfigResult ? <Callout status="warning" title="恢复指引" description="已保存的设置层不会重写。失败的保存层保留草稿；应用失败时只重试应用。" /> : null}{resultSummary?.elapsedMs !== undefined ? <StaticRow title="已用时" meta={`${Math.floor(resultSummary.elapsedMs / 1_000)}s`} /> : null}{visibleMessages.map((message, index) => <StaticRow key={`${index}:${message}`} title={productResultMessage(message)} status="muted" compact />)}</ResultCard><SemanticRows actions={actions} focus={focus} kind="action" compact offset={resultActionViewport.offset} limit={resultActionViewport.limit} /></Box>;
  } else if (route.name === 'pluginContent' && plugin) {
    const overview = props.controller.getPluginContentOverview(plugin.pluginId);
    const contentState = props.controller.getPluginContentState(plugin.pluginId);
    const contentAvailable = overview?.evidence === 'catalogBundle';
    breadcrumb = `${plugin.displayName} / 内容详情`;
    context = contentState === 'loading' ? '正在读取'
      : contentAvailable ? undefined : '内容不可用';
    title = '内容详情';
    description = undefined;
    const reader = contentReader?.pluginId === plugin.pluginId ? contentReader : undefined;
    const activeType = snapshot.router.current.context.contentTypeTab ?? 'all';
    const installedVersions = [...new Set((plugin.update?.targets ?? [])
      .flatMap((target) => target.installedVersion ? [target.installedVersion] : []))];
    const versionDiffers = contentAvailable
      && installedVersions.some((version) => version !== overview.pluginVersion);
    const allItems = overview?.items ?? [];
    const visibleTypes = [...new Set(allItems.map((item) => item.type))];
    const typeTabs: Array<'all' | PluginContentType> = ['all', ...visibleTypes];
    const selectedType = activeType === 'all' || visibleTypes.includes(activeType) ? activeType : 'all';
    const searchedItems = allItems.filter((item) => contentMatches(query, item));
    const items = searchedItems.filter((item) => selectedType === 'all' || item.type === selectedType);
    moveContentType = (direction) => {
      const next = typeTabs[(typeTabs.indexOf(selectedType) + direction + typeTabs.length) % typeTabs.length]!;
      const selectedId = items[focus]?.id;
      const nextItems = searchedItems.filter((item) => next === 'all' || item.type === next);
      const retained = nextItems.findIndex((item) => item.id === selectedId);
      props.controller.updatePageContext({ contentTypeTab: next });
      setFocus(retained >= 0 ? retained : 0);
      setScrollOffset(0);
      setBatchTargetOffset(0);
    };
    const itemActions: ActionItem[] = items.map((item) => ({
      actionId: `content:${item.id}`,
      label: item.name,
      ...(item.issue ? { status: 'warning' as const } : {}),
      run: () => {
        if (!contentItemHasReader(item, size.columns - 2)) return;
        setContentReader({ pluginId: plugin.pluginId, itemId: item.id,
          returnLineOffset: batchTargetOffset });
        setBatchTargetOffset(0);
      },
    }));
    bottomActions = [
      ...(overview?.coverageIssue ? [{ actionId: 'content-coverage-issue',
        label: '查看清单读取问题', status: 'warning' as const,
        run: () => { setContentReader({ pluginId: plugin.pluginId,
          returnLineOffset: batchTargetOffset }); setBatchTargetOffset(0); } }] : []),
      { actionId: 'content-technical', label: '查看技术详情',
        run: () => go({ name: 'pluginTechnical', pluginId: plugin.pluginId }) },
    ];
    actions = [...itemActions, ...bottomActions];
    if (reader) {
      const item = allItems.find((candidate) => candidate.id === reader.itemId);
      readingText = item ? [
        `名称 ${item.name}`, `类型 ${contentTypeLabels[item.type]}`,
        `适用工具 ${item.tools.length ? item.tools.join('、') : '未确认'}`,
        ...(item.descriptionState !== 'issue' && item.description ? [`简介 ${item.description}`] : []),
        ...(item.issue ? [`读取问题 ${item.issue.code}`, item.issue.message] : []),
      ].join('\n') : overview?.coverageIssue
        ? [`清单覆盖 ${overview.coverage ?? '未确认'}`,
          `读取问题 ${overview.coverageIssue.code}`, overview.coverageIssue.message].join('\n') : '';
      title = item ? item.name : '清单读取问题';
      description = undefined;
      help = '←→ 或 PgUp/PgDn 阅读 · y 复制全文 · Esc 返回清单';
      content = readingPage(readingText, size.columns - 2, pageActionBudget(1));
    } else {
      const cardWidth = size.columns - 2;
      const lineLimit = 3;
      const layouts = items.map((item) => contentItemCardLayout(item, cardWidth));
      entityCardNavigation = { itemCount: items.length, factRows: layouts.map((card) => card.factRows), lineLimit };
      const coverageState = overview?.coverage ?? (contentAvailable ? 'complete' : 'unavailable');
      const showCoverage = contentAvailable && coverageState === 'partial';
      const showUnavailable = contentState !== 'loading' && coverageState === 'unavailable';
      const emptyHint = contentAvailable && coverageState !== 'unavailable' && items.length === 0
        && (query || selectedType !== 'all');
      const viewport = rowViewport({
        rowHeights: [...layouts.map((card, index) => contentItemCardWindowHeight(card,
          index === focus ? batchTargetOffset : 0, lineLimit)), ...bottomActions.map(() => 1)],
        focus, requestedOffset: scrollOffset,
        rowBudget: pageActionBudget(1 + Number(visibleTypes.length > 0) + 1
          + Number(showCoverage) + Number(showUnavailable && contentAvailable) + Number(emptyHint)),
      });
      help = `↑↓ 浏览内容 · ←→ 切换类型 · / 搜索 · a 下方操作${items[focus]
        && contentItemHasReader(items[focus]!, cardWidth) ? ' · Enter 阅读' : ''} · Esc 返回`;
      content = <Box flexDirection="column">
        <QueryHeader width={cardWidth}
          tabs={visibleTypes.length > 0 ? { label: '类型', items: typeTabs.map((type) => ({ id: type,
            label: type === 'all' ? '全部' : contentTypeLabels[type],
            count: type === 'all' ? searchedItems.length
              : searchedItems.filter((item) => item.type === type).length })), currentId: selectedType } : undefined}
          search={{ value: query, placeholder: '名称或可信简介', input: searchFocus
            ? <InputDisplay value={query} cursor={searchCursor}
              columns={querySearchWidth(size.columns - 2)} /> : undefined }} />
        {contentAvailable ? <Box width={cardWidth} justifyContent="space-between" height={1} overflow="hidden">
          <Text color={tuiTheme.colors.muted}>内容版本 <Text color={tuiTheme.colors.text}>{overview.pluginVersion}</Text></Text>
          <Text color={versionDiffers ? tuiTheme.roles.change : tuiTheme.colors.muted} wrap="truncate-end">
            安装 {installedVersions.length ? installedVersions.join('、') : '未确认'}
          </Text>
        </Box> : contentState === 'loading'
          ? <StaticRow title="正在读取内容" status="muted" compact />
          : <StaticRow title="内容暂不可用" status="warning" compact />}
        {showCoverage ? <StaticRow title="清单覆盖不完整；数量仅含已确认条目" status="warning" compact /> : null}
        {showUnavailable && contentAvailable
          ? <StaticRow title="清单无法确认" status="warning" compact /> : null}
        {emptyHint ? <Text color={tuiTheme.colors.muted}>当前条件无匹配；查询保持原样。</Text> : null}
        {contentAvailable && allItems.length === 0 && coverageState === 'complete'
          ? <Text color={tuiTheme.colors.muted}>当前目录没有内容条目。</Text> : null}
        <ContentViewport>{actions.slice(viewport.offset, viewport.offset + viewport.limit)
          .map((action, visibleIndex) => {
            const index = viewport.offset + visibleIndex;
            if (index >= items.length) return <SemanticRows key={action.actionId} actions={actions}
              focus={searchFocus ? -1 : focus} kind="action" compact offset={index} limit={1} />;
            return <ContentItemCard key={action.actionId} item={items[index]!}
              width={cardWidth} focused={!searchFocus && focus === index}
              lineOffset={focus === index ? batchTargetOffset : 0} lineLimit={lineLimit} />;
          })}</ContentViewport>
      </Box>;
    }
  } else if (route.name === 'pluginTechnical' && plugin) {
    breadcrumb = `${plugin.displayName} / 技术详情`;
    context = '只读';
    title = plugin.capabilityUnsupported ? 'Capability 技术详情' : '安装与身份详情';
    description = plugin.capabilityUnsupported
      ? '当前 AW CLI 不支持此插件所需 capability。'
      : '默认页面不会展示这些内部信息。';
    actions = [{ role: 'navigation' as const, label: '返回插件', run: back }];
    const prioritizedComponents = plugin.technicalComponents.filter((component) =>
      !route.platform || component.platform === route.platform
        && (!route.scope || component.scope === route.scope || component.scope === undefined))
      .sort((left, right) => {
      const priority = (state: typeof left.state): number => state === 'error' ? 0
        : state === 'partial' ? 1 : state === 'absent' ? 2 : 3;
      return priority(left.state) - priority(right.state);
    });
    const technicalFields = [
      `canonical pluginId · ${plugin.pluginId}`,
      `来源 · ${plugin.sourceId}`,
      ...(route.platform ? [`目标平台 · ${platformLabel(route.platform)}`] : []),
      ...(route.scope ? [`目标位置 · ${scopeLabel(route.scope)}`] : []),
      ...prioritizedComponents.map((component) =>
        `组件 · ${component.state === 'absent' ? '缺失' : component.state}${component.errorCode ? ` · ${component.errorCode}` : ''} · ${component.key} · ${platformLabel(component.platform)} · ${component.shared ? '平台共享' : scopeLabel(component.scope!)}`),
      ...(plugin.capabilityUnsupported ? [
        'failure code · awCapabilityUnsupported',
        'capability 状态 · 当前 AW CLI 不支持',
        `缺少 capability · ${plugin.missingCapabilities?.join('、') ?? 'Status 未提供具体 capability'}`,
        `恢复方向 · ${plugin.capabilityRecovery ?? '升级 AW CLI 到支持所需 capability 的版本后重试。'}`,
      ] : []),
      ...plugin.installedPlacements.filter((placement) =>
        !route.platform || placement.platform === route.platform).flatMap((placement) => {
        if (placement.state === 'installed' && route.scope) {
          const scoped = placement.scopedPlacements?.find((entry) => entry.scope === route.scope);
          if (placement.scope !== route.scope && !scoped) return [];
          const target = scoped ? { ...placement, ...scoped, scopedPlacements: undefined } : placement;
          return [`${platformLabel(placement.platform)} · ${scopeLabel(route.scope)} target · ${placementStatus(target).value}`];
        }
        return [`${platformLabel(placement.platform)} target · ${placementStatus(placement).value}`];
      }),
      ...(route.platform && route.scope ? (props.controller.getPluginDetailSubject(plugin.pluginId)?.placements
        .filter((entry) => entry.platform === route.platform && entry.scope === route.scope)
        .map((entry) => `观察 · ${entry.observation === 'unknown' ? '未确认' : '已检查'} · 安装版本 ${entry.installedVersion ?? '未确认'}`)
        ?? []) : []),
    ];
    readingText = technicalFields.join('\n');
    content = <Box flexDirection="column">
      {readingPage(readingText, size.columns - 2, Math.max(1, pageActionBudget(4) - 1))}
      <SemanticRows actions={actions} focus={focus} kind="action" compact />
    </Box>;
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
      case 'pluginWriteTask': case 'pluginDetail': case 'pluginContent': case 'pluginMore': case 'platform': case 'pluginTechnical':
      case 'configLayer':
        unavailable = missingPlugin ? 'plugin' : 'flow';
        break;
      case 'portablePreparing': case 'portableSkillSelect': case 'portableDependencies': case 'portableAgentMode':
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

  if (snapshot.phase === 'ready' && !busy && !characterInput) {
    const hints: string[] = [];
    if (route.name === 'pluginList') hints.push('/ 搜索', 'f 筛选', '←→ 来源', 'm 多选');
    if (route.name === 'projectStatus' && !showTechnical) hints.push('/ 搜索', '←→ 分区', 'f 筛选');
    if (route.name === 'sourceList') {
      hints.push('/ 搜索');
      if (moveSourceType) hints.push('←→ 类型');
    }
    if (route.name === 'batchSelection' && batchDraft?.stage === 'select') {
      hints.push('/ 搜索', '←→ 来源', 'f 筛选');
      if (bottomActions.some((action) => action.actionId === 'batch-selection-continue' && !action.disabled)) hints.push('c 继续');
    }
    if (route.name === 'portableSkillSelect' && !portableToolsOpen) hints.push('/ 搜索', 'c 继续');
    if (bottomActions.some((action) => action.actionId === 'project-recheck' && !action.disabled)) hints.push('r 检查项目');
    if (bottomActions.some((action) => action.actionId === 'project-sync-actionable' && !action.disabled)) hints.push('c 同步声明');
    if (bottomActions.some((action) => action.actionId === 'source-check-all' && !action.disabled)) hints.push('r 检查全部');
    if (route.name === 'sourceDetail' || route.name === 'sourceMore') hints.push('r 检查来源');
    if (bottomActions.length > 0 && actions.length > bottomActions.length
      && bottomActions.some((action) => actions.includes(action))) hints.push('a 下方操作');
    if (entityCardNavigation && focus < entityCardNavigation.itemCount
      && (entityCardNavigation.factRows[focus] ?? 0) > entityCardNavigation.lineLimit) hints.push('PgUp/PgDn 翻信息');
    for (const hint of hints) {
      const key = hint.slice(0, hint.indexOf(' '));
      if (!help.split(' · ').some((part) => part.startsWith(`${key} `))) help += ` · ${hint}`;
    }
  }
  if (canOpenHelp && supportsTechnicalDetails) {
    const technicalHelp = showTechnical ? 'd 返回摘要' : route.name === 'progress' ? 'd 技术进度' : 'd 技术详情';
    const remainingHelp = help.split(' · ')
      .filter((item) => item !== '? 帮助' && !item.startsWith('d ')).join(' · ');
    help = `${technicalHelp} · ? 帮助 · ${remainingHelp}`;
  } else if (canOpenHelp && !help.includes('? 帮助')) {
    help = `? 帮助 · ${help}`;
  }
  if (props.onSessionNavigation && !characterInput) {
    help = busy
      ? `${props.pendingSessionNavigation === 'reload' ? '已安排完成后重载'
          : props.pendingSessionNavigation === 'home' ? '已安排完成后回首页'
            : 'h/H 完成后导航'} · Esc 撤销等待 · ${help}`
      : `h 首页 · H 重载 · ${help}`;
  }

  const helpParts = help.split(' · ');
  const isRoutineKey = (part: string): boolean => /^(↑|Enter|Space|Esc|Ctrl-C|←→|PgUp)/u.test(part);
  help = [...helpParts.filter(isRoutineKey), ...helpParts.filter((part) => !isRoutineKey(part))].join(' · ');
  if (searchFocus) help = '←→ 光标 · ↑↓ 移动结果 · Enter/Esc 完成输入';

  useEffect(() => {
    if ((bottomActions.length > 0 || route.name === 'issueList' || route.name === 'operationHistory')
      && focus >= actions.length && actions.length > 0) setFocus(actions.length - 1);
    else if (actions[focus]?.role === 'navigation') setFocus(moveFocus(actions, focus, 1));
  }, [routeKey, focus, actions.length, actions.map((action) => action.role ?? '').join(',')]);

  const listCandidates = route.name === 'pluginList'
    || route.name === 'batchSelection' && batchDraft?.stage === 'select'
    ? actions.filter((action) => action.pluginId !== undefined) : [];
  const listCandidateSignature = listCandidates.map((action) => action.pluginId).join('\0');
  const detailActionSignature = route.name === 'pluginDetail' || route.name === 'sourceDetail'
    ? actions.map((action) => action.actionId ?? action.label).join('\0') : undefined;
  useEffect(() => {
    if (detailActionSignature === undefined) {
      detailActionAnchor.current = undefined;
      return;
    }
    const previous = detailActionAnchor.current;
    if (previous?.routeKey === routeKey && previous.signature !== detailActionSignature
      && previous.actionId) {
      const index = actions.findIndex((action) => action.actionId === previous.actionId);
      if (index >= 0) {
        detailActionAnchor.current = { routeKey, signature: detailActionSignature,
          actionId: previous.actionId };
        setFocus(index);
        return;
      }
    }
    detailActionAnchor.current = { routeKey, signature: detailActionSignature,
      actionId: actions[focus]?.actionId };
  }, [routeKey, detailActionSignature, focus]);
  useEffect(() => {
    const pluginId = listCandidates[focus]?.pluginId;
    if (route.name === 'batchSelection' && batchDraft?.stage === 'select'
      && !batchDraft.showSelectionTools && pluginId) {
      batchSelectionAnchor.current = {
        frameId: snapshot.router.currentFrameId, pluginId, index: focus, scrollOffset,
      };
    }
  }, [snapshot.router.currentFrameId, route.name, batchDraft?.stage,
    batchDraft?.showSelectionTools, listCandidateSignature, focus, scrollOffset]);

  useEffect(() => {
    if (route.name !== 'pluginList' && !(route.name === 'batchSelection' && batchDraft?.stage === 'select')) {
      listFocusAnchor.current = undefined;
      return;
    }
    const previous = listFocusAnchor.current;
    let nextFocus = focus;
    if (previous?.frameId === snapshot.router.currentFrameId && previous.ids !== listCandidateSignature
      && previous.entityId) {
      const retained = listCandidates.findIndex((action) => action.pluginId === previous.entityId);
      nextFocus = retained >= 0 ? retained : Math.min(focus, Math.max(0, listCandidates.length - 1));
      if (nextFocus !== focus) setFocus(nextFocus);
    }
    listFocusAnchor.current = { frameId: snapshot.router.currentFrameId,
      ids: listCandidateSignature, entityId: listCandidates[nextFocus]?.pluginId };
  }, [snapshot.router.currentFrameId, route.name, batchDraft?.stage, listCandidateSignature, focus]);

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
    }
    dynamicMenuFocus.current = {
      routeKey,
      actionIds: dynamicActionSignature,
      focusedActionId: dynamicActionIds[effectiveFocus],
    };
  }, [dynamicActionSignature, routeKey, focus]);

  const runAction = (action: ActionItem | undefined): void => {
    if (!action || action.disabled || action.role === 'navigation') return;
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
    setArrayDrafts({});
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
    if (projectFlow && !overlay) {
      const flow = projectFlow;
      const sessionNavigation = resolveTuiSessionNavigationKey(
        { input, key }, { characterInput: false });
      if (sessionNavigation) {
        if (flow.stage === 'progress') return;
        if (flow.stage === 'preparing') props.controller.cancelProjectPreparation();
        projectFlowToken.current += 1;
        projectFlowEnterBusy.current = false;
        closeProjectFlow();
        requestSessionNavigation(sessionNavigation);
        return;
      }
      if (input.toLowerCase() === 'q' || key.ctrl && input.toLowerCase() === 'c') {
        if (flow.stage !== 'progress') requestConfirmedExit();
        return;
      }
      if (flow.stage === 'review' || flow.stage === 'result') {
        if (input.toLowerCase() === 'y' && readingText !== undefined) {
          void copyToClipboard(readingText).then(() =>
            setCopyFeedback({ routeKey, message: '全文已复制' })).catch(() =>
            setCopyFeedback({ routeKey, message: '复制失败，请重试' }));
          return;
        }
        if (key.pageUp || key.pageDown || key.leftArrow || key.rightArrow) {
          readerNavigation?.move(key.pageUp || key.leftArrow ? -1 : 1);
          return;
        }
      }
      if (flow.stage === 'preparing') {
        if (key.escape || input.toLowerCase() === 'b') {
          projectFlowToken.current += 1;
          projectFlowEnterBusy.current = false;
          props.controller.cancelProjectPreparation();
          setProjectFlow(flow.returnTo === 'targets'
            ? { stage: 'targets', agents: projectAgentsDraft, focus: 0 } : undefined);
          if (flow.returnTo === 'project') setBatchTargetOffset(projectPageAnchor.current);
        }
        return;
      }
      if (flow.stage === 'progress') return;
      if (key.escape || input.toLowerCase() === 'b') {
        if (flow.stage === 'review' && flow.returnTo === 'targets') {
          setProjectFlow({ stage: 'targets', agents: projectAgentsDraft, focus: 0 });
        } else closeProjectFlow();
        return;
      }
      if (key.upArrow || key.downArrow || input.toLowerCase() === 'j'
        || input.toLowerCase() === 'k') {
        setProjectFlow({ ...flow, focus: moveIndex(actions.length, flow.focus,
          key.upArrow || input.toLowerCase() === 'k' ? -1 : 1) });
        return;
      }
      if (key.return || input === ' ' && flow.stage === 'targets') {
        runAction(actions[flow.focus]);
      }
      return;
    }
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
    if (overlay === 'help' && (key.leftArrow || key.rightArrow || key.pageUp || key.pageDown)) {
      const current = readerPage({ text: helpTextForPage(help, busy), columns: size.columns - 6,
        rows: helpBodyRows, page: helpPage });
      setHelpPage(Math.min(current.pageCount,
        Math.max(1, current.page + (key.leftArrow || key.pageUp ? -1 : 1))));
      return;
    }
    if (busy) {
      const sessionNavigation = resolveTuiSessionNavigationKey(
        { input, key },
        { characterInput: false },
      );
      if ((key.pageUp || key.pageDown || key.leftArrow || key.rightArrow)
        && route.name === 'progress' && !overlay) {
        const total = snapshot.progressTargets.length;
        const pageRows = 1;
        setBatchTargetOffset((value) => Math.min(
          Math.max(0, total - 1),
          Math.max(0, value + (key.pageUp || key.leftArrow ? -pageRows : pageRows)),
        ));
      } else if (!overlay && input.toLowerCase() === 'y' && readingText !== undefined) {
        const currentRouteKey = routeKey;
        void copyToClipboard(readingText).then(() => {
          setCopyFeedback({ routeKey: currentRouteKey, message: '全文已复制' });
        }).catch(() => {
          setCopyFeedback({ routeKey: currentRouteKey, message: '复制失败，请重试' });
        });
      } else if (overlay === 'help') {
        if (key.escape || input.toLowerCase() === 'b' || input === '?') {
          setOverlay(undefined);
        } else if (key.upArrow || key.downArrow) {
          setOverlayFocus((value) => moveIndex(props.onSessionNavigation ? 3 : 1, value,
            key.upArrow ? -1 : 1));
        } else if (key.return) {
          setOverlay(undefined);
          if (props.onSessionNavigation && overlayFocus === 1) requestSessionNavigation('home');
          else if (props.onSessionNavigation && overlayFocus === 2) requestSessionNavigation('reload');
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
        setHelpPage(1);
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
    if (arrayToolsOpen && activeArrayDraft) {
      if (key.escape) setArrayToolsOpen(false);
      else if (key.upArrow) setArrayToolFocus((value) => Math.max(0, value - 1));
      else if (key.downArrow) setArrayToolFocus((value) => Math.min(2, value + 1));
      else if (key.return && activeArrayDraft.selectedRowId) {
        editArray(arrayToolFocus === 2
          ? { kind: 'remove', rowId: activeArrayDraft.selectedRowId }
          : { kind: 'move', rowId: activeArrayDraft.selectedRowId, offset: arrayToolFocus === 0 ? -1 : 1 });
        setArrayToolsOpen(false);
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
          if (reminder.kind === 'recovery') {
            const exactTargets = reminder.actionableTargets.map((target) => ({
              pluginId: target.pluginId, agent: target.agent,
            }));
            go({ name: 'projectStatus' });
            beginProjectTask({ kind: 'recovery', command: 'sync',
              selectors: [...new Set(exactTargets.map((target) => target.pluginId))],
              targets: [...new Set(exactTargets.map((target) => target.agent))], exactTargets });
          } else prepareCurrentProjectTargets(reminder.actionableTargets);
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
      } else if (input.toLowerCase() === 'y' && confirmationText !== undefined) {
        const currentRouteKey = `${routeKey}:confirmation`;
        void copyToClipboard(confirmationText).then(() => {
          setCopyFeedback({ routeKey: currentRouteKey, message: '全文已复制' });
        }).catch(() => {
          setCopyFeedback({ routeKey: currentRouteKey, message: '复制失败，请重试' });
        });
      } else if ((key.pageUp || key.pageDown || key.leftArrow || key.rightArrow)
        && confirmationPagination) {
        const warningCount = confirmationPagination.total;
        const warningLimit = confirmationPagination.pageRows;
        setOperationConfirmation((current) => current ? {
          ...current,
          warningOffset: pagedItems(warningCount, warningLimit,
            current.warningOffset + (key.pageUp || key.leftArrow ? -warningLimit : warningLimit)).offset,
        } : current);
      } else if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) {
        setOverlayFocus((value) => moveIndex(2,
          value, key.upArrow || key.leftArrow ? -1 : 1));
      } else if (key.return) {
        if (overlayFocus === 0) {
          closeConfirmation();
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
          setArrayDrafts({});
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
    if (input.toLowerCase() === 'y' && readingText !== undefined) {
      const currentRouteKey = routeKey;
      void copyToClipboard(readingText).then(() => {
        setCopyFeedback({ routeKey: currentRouteKey, message: '全文已复制' });
      }).catch(() => {
        setCopyFeedback({ routeKey: currentRouteKey, message: '复制失败，请重试' });
      });
      return;
    }
    if (readerNavigation && (key.pageUp || key.pageDown || key.leftArrow || key.rightArrow)) {
      readerNavigation.move(key.pageUp || key.leftArrow ? -1 : 1);
      return;
    }
    if (configCardNavigation && (key.pageUp || key.pageDown)) {
      setConfigCardPage({ key: configCardNavigation.key,
        page: Math.min(configCardNavigation.pageCount,
          Math.max(1, configCardNavigation.page + (key.pageUp ? -1 : 1))) });
      return;
    }
    if (route.name === 'platform' && (key.upArrow || key.downArrow
      || input.toLowerCase() === 'j' || input.toLowerCase() === 'k')) {
      const next = moveFocus(actions, effectiveFocus,
        key.upArrow || input.toLowerCase() === 'k' ? -1 : 1);
      const cardWidth = size.columns - 2;
      const viewport = rowViewport({
        rowHeights: actions.map((action, index) => index < platformFacts.length
          ? entityPlacementRowHeight({ ...platformFacts[index]!,
            shared: platformFacts[index]!.sharedWithCurrentProject }, cardWidth) + 1
          : action.role === 'navigation' ? 0 : 1),
        focus: next, requestedOffset: scrollOffset, rowBudget: pageActionBudget(3),
      });
      dynamicMenuFocus.current = dynamicActionIds && dynamicActionSignature
        ? { routeKey, actionIds: dynamicActionSignature,
          focusedActionId: actions[next]?.actionId } : undefined;
      setFocus(next);
      setScrollOffset(viewport.offset);
      return;
    }
    if (graphLayout && graphProjection) {
      const portable = route.name === 'portableDependencies';
      const graphPluginId = route.name === 'portableDependencies'
        || route.name === 'pluginDependencies' ? route.pluginId : '';
      if (graphEvidenceOpen || graphPortableSelectionOpen) {
        if (key.escape || input.toLowerCase() === 'b') {
          setGraphEvidenceOpen(false);
          setGraphPortableSelectionOpen(false);
          return;
        }
        if (input !== 'h' && input !== 'H' && input !== '?'
          && input.toLowerCase() !== 'q' && !(key.ctrl && input.toLowerCase() === 'c')) return;
      }
      const row = graphLayout.rows[focus] ?? graphLayout.rows[graphLayout.focusIndex];
      if (input.toLowerCase() === 'r' && row?.node.edge) {
        setGraphEvidenceOpen(true);
        setBatchTargetOffset(0);
        return;
      }
      if (portable && input.toLowerCase() === 'p') {
        setGraphPortableSelectionOpen(true);
        setBatchTargetOffset(0);
        return;
      }
      if (key.upArrow || key.downArrow || input.toLowerCase() === 'j'
        || input.toLowerCase() === 'k') {
        const next = moveIndex(graphLayout.rows.length, focus,
          key.upArrow || input.toLowerCase() === 'k' ? -1 : 1);
        const nextLayout = projectDependencyGraphView(graphProjection, {
          columns: size.columns - 2, rowBudget: graphRowBudget,
          focusRowId: graphLayout.rows[next]?.id,
          scrollAnchorRowId: graphLayout.rows[scrollOffset]?.id,
        });
        setFocus(nextLayout.focusIndex);
        setScrollOffset(nextLayout.viewport.offset);
        persistUnifiedDependencyGraphContext(graphPluginId, nextLayout,
          expandedDependencyPluginIds ?? new Set([
            ...graphProjection.dependencies.defaultExpandedPluginIds,
            ...graphProjection.dependents.defaultExpandedPluginIds,
          ]), nextLayout.focusIndex, nextLayout.viewport.offset, portable);
        return;
      }
      if ((key.leftArrow || key.rightArrow) && row) {
        const nextExpanded = new Set(expandedDependencyPluginIds ?? [
          ...graphProjection.dependencies.defaultExpandedPluginIds,
          ...graphProjection.dependents.defaultExpandedPluginIds,
        ]);
        if (key.rightArrow && row.node.canExpand) nextExpanded.add(row.node.pluginId);
        if (key.leftArrow && row.node.canExpand) nextExpanded.delete(row.node.pluginId);
        const nextProjection = buildUnifiedDependencyGraphProjection({
          overviews: props.controller.listPluginDependencyOverviews(),
          rootPluginId: graphPluginId, expandedPluginIds: nextExpanded,
        });
        const nextLayout = projectDependencyGraphView(nextProjection, {
          columns: size.columns - 2, rowBudget: graphRowBudget,
          focusRowId: row.id,
          scrollAnchorRowId: graphLayout.rows[scrollOffset]?.id,
        });
        setExpandedDependencyPluginIds(nextExpanded);
        setFocus(nextLayout.focusIndex);
        setScrollOffset(nextLayout.viewport.offset);
        persistUnifiedDependencyGraphContext(graphPluginId, nextLayout, nextExpanded,
          nextLayout.focusIndex, nextLayout.viewport.offset, portable);
        return;
      }
      if (key.return) {
        runAction(actions[focus]);
        return;
      }
    }
    if (route.name === 'pluginContent' && contentReader
      && !key.escape && input !== 'h' && input !== 'H' && input !== '?'
      && input.toLowerCase() !== 'q' && !(key.ctrl && input.toLowerCase() === 'c')) return;
    if (entityCardNavigation && focus < entityCardNavigation.itemCount
      && (key.pageUp || key.pageDown)) {
      const maxOffset = Math.max(0,
        (entityCardNavigation.factRows[focus] ?? 0) - entityCardNavigation.lineLimit);
      const step = entityCardNavigation.lineLimit;
      setBatchTargetOffset((value) => Math.min(maxOffset,
        Math.max(0, value + (key.pageUp || key.leftArrow
          ? -step : step))));
      return;
    }
    if ((key.pageUp || key.pageDown || key.leftArrow || key.rightArrow)
      && (route.name === 'portableDependencies' || route.name === 'pluginContent'
        || route.name === 'pluginTechnical'
        || route.name === 'projectStatus' && showTechnical
        || route.name === 'issueDetail' && showTechnical
        || route.name === 'portableBlocker' && showTechnical
        || route.name === 'configUnavailable' && showTechnical
        || route.name === 'sourceRemoveBlocked' && sourceDependenciesExpanded
        || route.name === 'pluginDependencies' && route.view === 'removeBlocked' && !showTechnical
        || route.name === 'pluginDependencyNode'
        || route.name === 'pluginDetail'
        || route.name === 'configSave' && route.view === 'changes'
        || route.name === 'configFields' && route.view === 'values'
        || route.name === 'sourceSave' && route.view === 'changes'
        || route.name === 'review'
        || route.name === 'pluginWriteTask'
        || route.name === 'result')
      && referenceDetailPagination) {
      const { total, pageRows } = referenceDetailPagination;
      moveBatchTargetPage(total, pageRows,
        key.pageUp || key.leftArrow ? -1 : 1);
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
    if (route.name === 'configFieldEditor' && route.mode !== 'choices' && input === 'c'
      && (route.editor === 'array' || route.editor === 'object')) {
      if (route.editor === 'array') commitArray();
      else commitObjectDraft();
      return;
    }
    if (route.name === 'configFieldEditor' && !arrayItem && activeField && key.ctrl && input.toLowerCase() === 'r') {
      const canUnset = (['project', 'user'] as const).some((scope) =>
        configLayerPages[scope]?.groups.flatMap((group) => group.fields)
          .some((field) => field.key === activeField.key && configFieldCanUnset(field)));
      if (canUnset) removeDraft(activeField.key);
      return;
    }
    if (route.name === 'configFieldEditor'
      && (route.editor === 'string' || route.editor === 'number')
      && ((activeField?.choices?.length ?? 0) === 0 || route.mode === 'custom')
      && (['project', 'user'] as const).some((scope) => configLayerPages[scope]?.groups.flatMap((group) => group.fields)
        .some((field) => field.key === activeField?.key && configFieldCanSet(field)))) {
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
          if (parseConfigNumberInput(inputValue) === undefined) {
            setInputError('请输入数字；空输入不会保存为 0。');
            return;
          }
          candidate = parseConfigNumberInput(inputValue)!;
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
        if (activePropertyDefinition.type === 'number' && parseConfigNumberInput(inputValue) === undefined) {
          setInputError('请输入数字；空输入不会保存为 0。');
          return;
        }
        const candidate: PluginConfigScalar = activePropertyDefinition.type === 'number'
          ? parseConfigNumberInput(inputValue)! : inputValue;
        if (updateObjectProperty(route.propertyKey, candidate)) back();
        return;
      }
      if (key.backspace || key.delete) setInputValue(removeLastGrapheme);
      else if (input && !key.ctrl && !key.meta && input >= ' ') setInputValue((value) => value + input);
      setInputError(undefined);
      return;
    }
    if (searchFocus && (route.name === 'pluginList' || route.name === 'projectStatus'
      || route.name === 'pluginContent'
      || route.name === 'batchSelection' || route.name === 'sourceList'
      || route.name === 'portableSkillSelect')) {
      const currentQuery = route.name !== 'batchSelection' ? query : batchDraft?.query ?? '';
      const parts = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(currentQuery)]
        .map((part) => part.segment);
      const cursor = Math.min(searchCursor, parts.length);
      if (key.escape || key.return) {
        setSearchFocus(false);
        return;
      }
      if (key.upArrow || key.downArrow) {
        setSearchFocus(false);
        const candidateCount = route.name === 'batchSelection' && batchDraft
          ? batchCandidates(batchDraft).length
          : route.name === 'projectStatus' || route.name === 'pluginContent'
            || route.name === 'portableSkillSelect'
            || route.name === 'sourceList' ? actions.length - bottomActions.length : pluginRows.length;
        setFocus((value) => moveIndex(candidateCount,
          Math.min(value, Math.max(0, candidateCount - 1)), key.upArrow ? -1 : 1));
        return;
      }
      if (key.leftArrow || key.rightArrow) {
        setSearchCursor(Math.min(parts.length, Math.max(0, cursor + (key.leftArrow ? -1 : 1))));
        return;
      }
      let nextCursor = cursor;
      if (input === '\u0015' || input.toLowerCase() === 'u' && key.ctrl) {
        parts.splice(0);
        nextCursor = 0;
      } else if (key.backspace || key.delete) {
        if (cursor > 0) parts.splice(--nextCursor, 1);
      } else if (input && !key.ctrl && !key.meta && input >= ' ') {
        const inserted = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(input)]
          .map((part) => part.segment);
        parts.splice(cursor, 0, ...inserted);
        nextCursor += inserted.length;
      }
      const nextQuery = parts.join('');
      setSearchCursor(nextCursor);
      const focusedId = actions[focus]?.actionId;
      let retained = -1;
      if (focusedId) {
        if (route.name === 'pluginList') {
          const ids = props.controller.listPlugins({ mode: route.mode,
            ...(route.sourceId ? { sourceId: route.sourceId } : {}),
            ...(nextQuery ? { query: nextQuery } : {}), installFilter }).map((item) => `plugin:${item.pluginId}`);
          retained = ids.indexOf(focusedId);
        } else if (route.name === 'projectStatus') {
          const section = snapshot.router.current.context.projectSection ?? 'declared';
          const filter = snapshot.router.current.context.projectStatusFilter ?? 'all';
          retained = props.controller.listProjectInventoryRoots(section).filter((root) =>
            queryMatches(nextQuery, root.displayName, root.pluginId, root.sourceId)
              && (filter === 'all' || root.state === filter))
            .findIndex((root) => `project-root:${root.pluginId}` === focusedId);
        } else if (route.name === 'pluginContent') {
          const type = snapshot.router.current.context.contentTypeTab ?? 'all';
          retained = (props.controller.getPluginContentOverview(route.pluginId)?.items ?? [])
            .filter((item) => contentMatches(nextQuery, item)
              && (type === 'all' || item.type === type))
            .findIndex((item) => `content:${item.id}` === focusedId);
        } else if (route.name === 'sourceList') {
          retained = matchingSources(props.controller, nextQuery,
            snapshot.router.current.context.sourceTypeTab ?? 'all')
            .findIndex((source) => `source:${source.id}` === focusedId);
        } else if (route.name === 'portableSkillSelect') {
          retained = (snapshot.portableDraft?.candidates ?? []).filter((candidate) =>
            (portableSelectionView === 'all' || candidate.selected)
              && queryMatches(nextQuery, candidate.name,
                candidate.shortDescription ?? candidate.description.split(/[。！？\n]/u)[0]))
            .findIndex((candidate) => `skill:${candidate.providerPluginId}:${candidate.name}` === focusedId);
        } else if (batchDraft) {
          retained = batchCandidates({ ...batchDraft, query: nextQuery, showSelected: false })
            .findIndex((candidate) => candidate.pluginId === actions[focus]?.pluginId);
        }
      }
      if (route.name !== 'batchSelection') {
        setQuery(nextQuery);
        props.controller.updatePageContext({ query: nextQuery });
        if (route.name === 'projectStatus') {
          dynamicMenuFocus.current = undefined;
          actionJumpAnchor.current = undefined;
        }
      } else {
        setBatchDraft((draft) => draft ? { ...draft, query: nextQuery, showSelected: false } : draft);
      }
      setFocus(retained >= 0 ? retained : 0);
      setScrollOffset(retained >= 0 ? Math.min(scrollOffset, retained) : 0);
      return;
    }
    // Paste and composed text are data, never multiple background commands.
    if (input.length > 1 && !key.ctrl && !key.meta) return;
    if (key.tab) return;
    if ((route.name === 'projectStatus' && !showTechnical
      || route.name === 'pluginContent' && !contentReader
      || route.name === 'sourceList' || route.name === 'portableSkillSelect' && !portableToolsOpen) && input === '/') {
      setSearchCursor([...new Intl.Segmenter(undefined, { granularity: 'grapheme' })
        .segment(query)].length);
      setSearchFocus(true);
      return;
    }
    if (route.name === 'pluginList' && input === '/') {
      runAction(listQueryActions.find((action) => action.actionId === 'plugin-list-search'));
      return;
    }
    if (route.name === 'pluginList' && input.toLowerCase() === 'm') {
      runAction(bottomActions.find((action) => action.actionId === 'plugin-list-multi'));
      return;
    }
    if (input.toLowerCase() === 'a' && route.name === 'sourceDetail'
      && entityCardNavigation) {
      setFocus(focus === 0 ? Math.min(1, actions.length - 1) : 0);
      setScrollOffset(0);
      return;
    }
    if (input.toLowerCase() === 'a' && bottomActions.length > 0) {
      const firstAction = actions.findIndex((action) => bottomActions.includes(action));
      if (firstAction >= 0) {
        const anchor = actionJumpAnchor.current;
        if (anchor?.routeKey === routeKey && focus >= firstAction) {
          const entityIndex = anchor.entityId
            ? actions.findIndex((action) => action.pluginId === anchor.entityId) : -1;
          const next = entityIndex >= 0 ? entityIndex : Math.min(anchor.index, Math.max(0, firstAction - 1));
          if (route.name === 'projectStatus' && dynamicActionIds && dynamicActionSignature) {
            dynamicMenuFocus.current = { routeKey, actionIds: dynamicActionSignature,
              focusedActionId: dynamicActionIds[next] };
          }
          setFocus(next);
          actionJumpAnchor.current = undefined;
        } else {
          actionJumpAnchor.current = { routeKey, index: focus, entityId: actions[focus]?.pluginId };
          if (route.name === 'projectStatus' && dynamicActionIds && dynamicActionSignature) {
            dynamicMenuFocus.current = { routeKey, actionIds: dynamicActionSignature,
              focusedActionId: dynamicActionIds[firstAction] };
          }
          setFocus(firstAction);
        }
        setScrollOffset(0);
      }
      return;
    }
    if (key.tab && (route.name === 'configLayer'
      || route.name === 'configFields'
      || route.name === 'configFieldEditor'
      || route.name === 'configObjectPropertyEditor')) {
      return;
    }
    const sessionNavigation = resolveTuiSessionNavigationKey(
      { input, key },
      { characterInput },
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
      setHelpPage(1);
      setOverlay('help');
    } else if (globalAction === 'exit') {
      requestConfirmedExit();
    } else if (input.toLowerCase() === 'd' && supportsTechnicalDetails) {
      toggleTechnical();
    } else if (globalAction === 'back' && route.name === 'pluginContent' && contentReader) {
      setContentReader(undefined);
      setBatchTargetOffset(contentReader.returnLineOffset);
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
      closeBatchSelectionTools();
    } else if (globalAction === 'back' && route.name === 'installPlacement'
      && returnToPreviousInstallPlatform) {
      returnToPreviousInstallPlatform();
    } else if (globalAction === 'back'
      && (route.name === 'configSave' || route.name === 'sourceSave' && route.view === 'changes')) {
      back();
    } else if (globalAction === 'back' && route.name === 'configLayer') {
      back();
    } else if (globalAction === 'back'
      && route.name === 'configObjectPropertyEditor') {
      back();
    } else if (globalAction === 'back'
      && (route.name === 'configFieldEditor' || route.name === 'configFieldAction')) {
      setConfigCandidate(undefined);
      if (activeArrayKey && !arrayItem) {
        setArrayDrafts((current) => Object.fromEntries(Object.entries(current).filter(([key]) => key !== activeArrayKey)));
        setObjectError(undefined);
      }
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
      runAction(listQueryActions.find((action) => action.actionId === 'plugin-list-filter'));
    } else if (route.name === 'batchSelection' && batchDraft?.stage === 'select'
      && input.toLowerCase() === 'f') {
      const filters = PLUGIN_FILTERS.filter((filter) => filter === 'all' || filter === batchDraft.installFilter
        || batchCandidates({ ...batchDraft, installFilter: filter }).length > 0);
      const nextFilter = filters[(filters.indexOf(batchDraft.installFilter) + 1) % filters.length]!;
      setBatchDraft((current) => current ? {
        ...current,
        installFilter: nextFilter,
        showSelected: false,
      } : current);
      setFocus(0);
      setScrollOffset(0);
    } else if (route.name === 'projectStatus' && input.toLowerCase() === 'f' && !showTechnical) {
      toggleProjectStatusFilter?.();
    } else if (route.name === 'projectStatus' && input.toLowerCase() === 's'
      && snapshot.projectInventory?.recovery && !showTechnical) {
      const pluginId = actions[effectiveFocus]?.pluginId;
      if (pluginId && snapshot.projectInventory.declaredRoots.some((root) => root.pluginId === pluginId)) {
        beginProjectTask({ kind: 'recovery', selectors: [pluginId] });
      }
    } else if (route.name === 'projectStatus' && input.toLowerCase() === 'x'
      && snapshot.projectInventory?.recovery && !showTechnical) {
      const pluginId = actions[effectiveFocus]?.pluginId;
      const root = snapshot.projectInventory.recovery.inventory?.find((entry) => entry.pluginId === pluginId);
      if (root?.sourceState === 'ready'
        && root.blockers.some((blocker) => blocker.code === 'pluginUnavailable')) {
        beginProjectTask({ kind: 'recovery', command: 'cleanup', selectors: [pluginId!] });
      }
    } else if (route.name === 'projectStatus' && input.toLowerCase() === 't'
      && snapshot.projectInventory?.recovery && !showTechnical) {
      runAction(bottomActions.find((action) => action.actionId === 'project-targets'));
    } else if (route.name === 'projectStatus' && input.toLowerCase() === 'r') {
      runAction(bottomActions.find((action) => action.actionId === 'project-recheck'));
    } else if (route.name === 'projectStatus' && input.toLowerCase() === 'c') {
      runAction(bottomActions.find((action) => action.actionId === 'project-sync-actionable'));
    } else if (route.name === 'installTargets' && route.view !== 'blocked'
      && input.toLowerCase() === 'c') {
      runAction(bottomActions.find((action) => action.actionId === 'confirm-install-platforms'));
    } else if (route.name === 'batchInstallPlatforms' && input.toLowerCase() === 'c') {
      runAction(actions.find((action) => action.actionId === 'batch-install-platforms-confirm'));
    } else if (route.name === 'batchInstallScope' && input.toLowerCase() === 'c') {
      runAction(actions.find((action) => action.actionId === 'batch-placement-confirm'));
    } else if (route.name === 'batchPlacement' && bottomActions.length > 0
      && input.toLowerCase() === 'c') {
      runAction(actions.find((action) => action.actionId === 'batch-placement-confirm'));
    } else if (route.name === 'batchSelection' && batchDraft?.stage === 'select' && input.toLowerCase() === 'c') {
      runAction(bottomActions.find((action) => action.actionId === 'batch-selection-continue'));
    } else if (route.name === 'batchSelection' && batchDraft?.stage === 'select'
      && input === ' ') {
      const action = actions[normalizedEffectiveFocus];
      if (action?.pluginId
        && (batchDraft.selectedPluginIds.includes(action.pluginId) || action.canSelectNew)) {
        toggleBatchPlugin(action.pluginId);
      }
    } else if (route.name === 'installTargets' && route.view !== 'blocked'
      && input === ' ') {
      const action = actions[focus];
      if (action?.actionId?.startsWith('install-platform-')) runAction(action);
    } else if (route.name === 'batchInstallPlatforms'
      && input === ' ') {
      const action = actions[focus];
      if (action?.actionId === 'batch-install-platform-codex'
        || action?.actionId === 'batch-install-platform-claude') runAction(action);
    } else if (route.name === 'batchSelection' && batchDraft?.stage === 'select' && input === '/') {
      setSearchCursor([...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(batchDraft.query)].length);
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
      runAction(bottomActions[0]);
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
    } else if (route.name === 'configFields' && !route.view && visibleConfigTabs.length > 1
      && (key.leftArrow || key.rightArrow)) {
      const current = Math.max(0, visibleConfigTabs.findIndex((tab) => tab.id === activeConfigTabId));
      const direction = key.leftArrow ? -1 : 1;
      const next = visibleConfigTabs[(current + direction + visibleConfigTabs.length) % visibleConfigTabs.length]!;
      props.controller.updatePageContext({ configGroupId: next.id, focusIndex: 0, scrollOffset: 0 });
      setFocus(0);
      setScrollOffset(0);
    } else if (route.name === 'projectStatus' && !showTechnical
      && (key.leftArrow || key.rightArrow)) {
      moveProjectSection?.(key.leftArrow ? -1 : 1);
    } else if (route.name === 'pluginContent' && !contentReader
      && (key.leftArrow || key.rightArrow)) {
      moveContentType?.(key.leftArrow ? -1 : 1);
    } else if (route.name === 'sourceList' && (key.leftArrow || key.rightArrow)) {
      moveSourceType?.(key.leftArrow ? -1 : 1);
    } else if ((input.toLowerCase() === 'r' || input.toLowerCase() === 'c')
      && (route.name === 'sourceDetail' || route.name === 'sourceMore')) {
      void props.controller.recheckCatalogSource(route.sourceId);
    } else if ((input.toLowerCase() === 'r' || input.toLowerCase() === 'c')
      && route.name === 'sourceList') {
      runAction(bottomActions.find((action) => action.actionId === 'source-check-all'));
    } else if (route.name === 'pluginList' && (key.leftArrow || key.rightArrow || input === '[' || input === ']')) {
      const direction = key.leftArrow || input === '[' ? -1 : 1;
      movePluginListSource?.(direction);
    } else if (input.toLowerCase() === 'c' && route.name === 'portableSkillSelect') {
      runAction(bottomActions.find((action) => action.actionId === 'portable-selection-continue'));

    } else if (input === ' ' && route.name === 'portableSkillSelect'
      && !portableToolsOpen) {
      const candidate = portableVisibleCandidates[focus];
      if (candidate) props.controller.togglePortableSkill(candidate.name);
    } else if (entityCardNavigation && focus < entityCardNavigation.itemCount
      && (key.upArrow || input.toLowerCase() === 'k') && batchTargetOffset > 0) {
      setBatchTargetOffset((value) => value - 1);
    } else if (entityCardNavigation && focus < entityCardNavigation.itemCount
      && (key.downArrow || input.toLowerCase() === 'j')
      && batchTargetOffset < Math.max(0,
        (entityCardNavigation.factRows[focus] ?? 0) - entityCardNavigation.lineLimit)) {
      setBatchTargetOffset((value) => value + 1);
    } else if (key.upArrow || input.toLowerCase() === 'k') {
      if (entityCardNavigation) setBatchTargetOffset(0);
      if (route.name === 'pluginDependencyNode' && route.view === 'references' && !showTechnical) {
        setBatchTargetOffset(0);
      }
      setFocus((value) => {
        const current = route.name === 'batchSelection' && batchDraft?.stage === 'select'
          ? normalizedEffectiveFocus : dynamicActionIds ? effectiveFocus : value;
        const next = route.name === 'sourceDetail' ? moveIndex(actions.length, current, -1)
            : moveFocus(actions, current, -1);
        if (dynamicActionIds && dynamicActionSignature !== undefined) {
          dynamicMenuFocus.current = {
            routeKey,
            actionIds: dynamicActionSignature,
            focusedActionId: dynamicActionIds[next],
          };
        }
        const viewport = actionViewport(actions, policy.mode === 'compact', next,
          scrollOffset, currentActionViewportLineBudget);
        if (bottomActions.length === 0) setScrollOffset(viewport.offset);
        return next;
      });
    } else if (key.downArrow || input.toLowerCase() === 'j') {
      if (entityCardNavigation) setBatchTargetOffset(0);
      if (route.name === 'pluginDependencyNode' && route.view === 'references' && !showTechnical) {
        setBatchTargetOffset(0);
      }
      setFocus((value) => {
        const current = route.name === 'batchSelection' && batchDraft?.stage === 'select'
          ? normalizedEffectiveFocus : dynamicActionIds ? effectiveFocus : value;
        const next = route.name === 'sourceDetail' ? moveIndex(actions.length, current, 1)
            : moveFocus(actions, current, 1);
        if (dynamicActionIds && dynamicActionSignature !== undefined) {
          dynamicMenuFocus.current = {
            routeKey,
            actionIds: dynamicActionSignature,
            focusedActionId: dynamicActionIds[next],
          };
        }
        const viewport = actionViewport(actions, policy.mode === 'compact', next,
          scrollOffset, currentActionViewportLineBudget);
        if (bottomActions.length === 0) setScrollOffset(viewport.offset);
        return next;
      });
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

  if (readingText !== undefined && route.name !== 'progress') {
    const paginated = readerNavigation !== undefined || referenceDetailPagination !== undefined
      || route.name === 'sourceTechnical'
      || route.name === 'operationDiagnostic'
      || route.name === 'operationReportPreview'
      || route.name === 'portableDependencies';
    help = graphEvidenceOpen || graphPortableSelectionOpen
      ? '←→/PgUp/PgDn 翻页 · [y] 复制全文 · Esc 返回关系图'
      : route.name === 'pluginContent' && contentReader
      ? `${paginated ? '←→/PgUp/PgDn 翻页 · ' : ''}[y] 复制全文 · Esc 返回清单`
      : `${paginated ? '←→ 翻页 · ' : ''}[y] 复制全文 · Esc 返回${supportsTechnicalDetails
        ? showTechnical ? ' · d 返回摘要' : ' · d 技术详情' : ''}${actions.length > 0
        ? ` · ${size.columns < 80 ? '↑↓/Enter 菜单' : '↑↓ 移动 · Enter 选择'}` : ''}`;
    if (canOpenHelp) help += ' · ? 帮助';
    if (copyFeedback?.routeKey === routeKey) description = copyFeedback.message;
  }
  if (actionError) description = actionError;
  const base = (
    <ScreenFrame title={projectReminderOpen ? '' : title}
      description={projectReminderOpen ? undefined : description}
      breadcrumb={breadcrumb} context={context}
      headerHint={!projectReminderOpen && route.name === 'pluginList' ? { key: 'm', label: '多选' } : undefined}
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
  if (arrayToolsOpen && activeArrayDraft && activeField?.definition.type === 'array') {
    const index = activeArrayDraft.rows.findIndex((row) => row.rowId === activeArrayDraft.selectedRowId);
    const row = activeArrayDraft.rows[index];
    return <Box position="relative" width={size.columns} height={size.rows}>
      <Box>{base}</Box>
      <Box position="absolute" marginTop={3} marginLeft={3} width={size.columns - 6} flexDirection="column">
        <ReviewCard title={`调整第 ${index + 1} 项`} description={row ? presentConfigValue({
          definition: activeField.definition.items, value: row.value, summary: activeField.itemSummary,
        }).text : ''}>
          <SemanticRows actions={[{ label: '上移' }, { label: '下移' }, { label: '删除这一项', status: 'error' }]}
            focus={arrayToolFocus} kind="action" compact />
          <Text>↑↓ 选择 · Enter 确认 · Esc 返回</Text>
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
          title={pluginCount > 0 ? `本项目有 ${pluginCount} 个插件尚未就绪` : '项目状态需要检查'}
          description={`${reminder.actionableTargets.length} 个位置可同步；`
            + `${reminder.blockedTargets.length} 个位置需要先处理；`
            + `${reminder.unconfirmedTargets.length} 个位置未确认。`}
        >
          <StaticRow title="按项目共享设置恢复，个人设置不会被清空。" compact />
          {reminder.kind === 'recovery' && reminder.diagnosticCodes.length > 0
            ? <StaticRow title={`诊断：${reminder.diagnosticCodes.join('、')}`} status="warning" compact /> : null}
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
    const warningPage = paginateWrappedRows({ lines: warningLines, rows: warningLimit,
      page: Math.floor(operationConfirmation.warningOffset / warningLimit) + 1 });
    const visibleWarnings = shortConfirmation
      ? warningLines : warningPage.lines;
    const warningPaginated = !shortConfirmation && warningLines.length > warningLimit;
    confirmationText = portableUserConfirmation
      ? '! 本次在所有项目范围安装选定 Skills。\n具体对象和范围以刚才的汇总为准。'
      : [
          `操作：${review.title} · ${review.subject.name}`,
          ...(review.confirmationDetails ?? []),
          ...operationRiskWarnings(review).map((warning) => `! ${warning}`),
        ].join('\n');
    if (warningPaginated) {
      confirmationPagination = { total: warningLines.length, pageRows: warningLimit };
    }
    const confirmationActions: ActionItem[] = [
      { label: '返回检查', description: '回到完整操作汇总' },
      {
        label: portableUserConfirmation ? '确认并执行' : `我已了解影响，${review.primaryLabel}`,
        status: 'error',
      },
    ];
    const confirmationCard = (
      <ReviewCard title={portableUserConfirmation ? '确认本次影响' : '请确认本次风险'}
        description={`${copyFeedback?.routeKey === `${routeKey}:confirmation`
          ? `${copyFeedback.message} · ` : ''}确认只对当前操作汇总有效；[y] 复制全文。`}>
        {visibleWarnings.length > 0
          ? visibleWarnings.map((warning, index) => <StaticRow key={`${warningPage.offset + index}:${warning}`} title={warning} status={warning.startsWith('! ') ? 'warning' : 'info'} compact />)
          : <StaticRow title="! 此操作需要明确授权" status="warning" compact />}
        {warningPaginated
          ? <Pager page={warningPage.page} pageCount={warningPage.pageCount} columns={modalWidth - 6} /> : null}
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
      help="←→/PgUp/PgDn 翻页 · [y] 复制全文 · Esc 返回"
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
  if (!overlay) return base;
  const helpText = helpTextForPage(help, busy);
  const overlayActions: ActionItem[] = overlay === 'help'
    ? [
        { label: '关闭' },
        ...(props.onSessionNavigation ? [
          { label: busy ? '操作成功后返回首页' : '返回首页' },
          { label: busy ? '操作成功后重载' : '返回首页并重新加载' },
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
          ? <Reader text={helpText} columns={size.columns - 6} rows={helpBodyRows} page={helpPage} />
          : <StaticRow title={overlay === 'discard'
            ? discardForExit ? '放弃后将退出控制台。' : '放弃后将返回上一页。'
            : overlay === 'sessionNavigation'
              ? `放弃后将${discardForSessionNavigation === 'reload' ? '重新读取本地状态' : '返回首页'}。`
              : '进行中的写操作会先完成。'} status="muted" />}
        <SemanticRows actions={overlayActions} focus={overlayFocus} kind="action" compact />
        {overlay === 'help' ? <Text color={tuiTheme.colors.muted}>
          ←→ 翻帮助 · ↑↓ 选择操作 · Enter 确认 · Esc 关闭
        </Text> : null}
        </ReviewCard>
      </Box>
    </Box>
  );
}
