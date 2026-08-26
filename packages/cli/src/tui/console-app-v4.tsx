import { Box, Text, useInput, useWindowSize } from 'ink';
import { useEffect, useRef, useState } from 'react';
import path from 'node:path';

import type { CatalogSource, PlatformName, Scope } from '../types.js';
import { CATALOG_SOURCE_ID_PATTERN } from '../utils/catalog-sources.js';
import { canonicalizeCatalogGitUrl } from '../utils/catalog-source-identity.js';
import { normalizePortableAgents } from '../portable/commands.js';
import { projectCatalogSourceLocation } from '../utils/catalog-source-presentation.js';
import {
  ActionRow,
  Callout,
  ChoiceRow,
  InputCard,
  PluginRow,
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
import type {
  OperationIntent,
  OperationReviewChange,
  OperationResultSummary,
  TuiController,
  TuiControllerSnapshot,
} from './controller.js';
import { extractPortableError, userIssueKey } from './controller.js';
import { resolveTuiSizePolicy } from './layout.js';
import type {
  ConfigFieldViewModel,
  ConfigPageViewModel,
  PlatformPlacementSummary,
  PluginDependencyItemViewModel,
  PluginDependencyOverviewViewModel,
  PluginListItemViewModel,
  UserIssueActionViewModel,
  UserIssueViewModel,
} from './model.js';
import { hasInstalledPlacement } from './model.js';
import type { TuiRoute } from './router.js';
import { tuiTheme } from './theme.js';

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

type SemanticRowKind = 'task' | 'plugin' | 'section' | 'choice' | 'toggle' | 'action';

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

function configOwnerKey(route: Extract<TuiRoute, {
  name: 'configFields' | 'configFieldEditor' | 'configPresets';
}>): string {
  return `${route.pluginId}\0${route.layer.scope}\0${route.layer.projectLayer}`;
}

function configPageMatches(
  page: ConfigPageViewModel | undefined,
  route: Extract<TuiRoute, { name: 'configFields' | 'configFieldEditor' | 'configPresets' }> | undefined,
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

function moveFocus(actions: ActionItem[], current: number, direction: -1 | 1): number {
  if (actions.length === 0) return 0;
  for (let offset = 1; offset <= actions.length; offset += 1) {
    const next = (current + direction * offset + actions.length) % actions.length;
    if (!actions[next]?.disabled) return next;
  }
  return current;
}

function actionLimitForLineBudget(actions: ActionItem[], lineBudget: number): number {
  let used = 0;
  let count = 0;
  for (const action of actions) {
    const height = action.description || action.disabled ? 2 : 1;
    if (count > 0 && used + height > lineBudget) break;
    used += height;
    count += 1;
  }
  return Math.max(1, count);
}

function lineBudgetViewport(
  actions: ActionItem[],
  focus: number,
  requestedOffset: number,
  lineBudget: number,
  groupKeys?: Array<string | undefined>,
): { limit: number; offset: number } {
  const height = (start: number, end: number): number => {
    let lines = 0;
    let previousGroup: string | undefined;
    for (let index = start; index < end; index += 1) {
      const group = groupKeys?.[index];
      if (group && group !== previousGroup) lines += 1;
      lines += actions[index]?.description || actions[index]?.disabled ? 2 : 1;
      previousGroup = group;
    }
    return lines;
  };
  let offset = Math.min(requestedOffset, Math.max(0, actions.length - 1));
  if (focus < offset) offset = focus;
  while (offset < focus && height(offset, focus + 1) > lineBudget) offset += 1;
  let end = Math.max(offset + 1, focus + 1);
  while (end < actions.length && height(offset, end + 1) <= lineBudget) end += 1;
  return { offset, limit: Math.max(1, end - offset) };
}

function actionViewport(
  routeName: TuiRoute['name'],
  actions: ActionItem[],
  mode: 'single-column' | 'compact' | 'too-small',
  focus: number,
  requestedOffset: number,
): { limit?: number; offset: number } {
  if (routeName === 'portableDependencies') {
    return lineBudgetViewport(actions, focus, requestedOffset, mode === 'compact' ? 7 : 12);
  }
  const limit = routeName === 'pluginList' || routeName === 'issueList' || routeName === 'sourceList'
    ? actionLimitForLineBudget(actions, mode === 'compact' ? 8 : 12)
    : routeName === 'pluginDependencies' ? mode === 'compact' ? 2 : 7
      : mode === 'compact' ? 4
        : routeName === 'configFields' || routeName === 'review' || routeName === 'issueDetail' ? 7 : undefined;
  if (limit === undefined) return { offset: 0 };
  const maximumOffset = Math.max(0, actions.length - limit);
  let offset = Math.min(requestedOffset, maximumOffset);
  if (focus < offset) offset = focus;
  else if (focus >= offset + limit) offset = focus - limit + 1;
  return { limit, offset: Math.max(0, offset) };
}

function portableSkillCandidateViewport(
  actions: ActionItem[],
  candidates: NonNullable<TuiControllerSnapshot['portableDraft']>['candidates'],
  mode: 'single-column' | 'compact' | 'too-small',
  focus: number,
  requestedOffset: number,
): { limit: number; offset: number } {
  const candidateFocus = focus < candidates.length ? focus : requestedOffset;
  const limit = mode === 'compact' ? 2 : 3;
  const maximumOffset = Math.max(0, actions.length - limit);
  let offset = Math.min(requestedOffset, maximumOffset);
  if (candidateFocus < offset) offset = candidateFocus;
  else if (candidateFocus >= offset + limit) offset = candidateFocus - limit + 1;
  return { limit, offset: Math.max(0, offset) };
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
          meta: action.meta,
          status: action.status,
          disabled: action.disabled,
          focused: index === props.focus && !action.disabled,
          compact: props.compact,
        };
        if (props.kind === 'plugin') return <PluginRow key={`${action.label}:${index}`} {...rowProps} />;
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

function SourceTabs(props: {
  controller: TuiController;
  current: string;
  compact: boolean;
  mode: 'browse' | 'installed';
}): React.JSX.Element {
  const tabs = [{ id: 'all', label: '全部', count: props.controller.listPlugins({ mode: props.mode }).length },
    ...props.controller.listSources().map((source) => ({
      ...source,
      count: props.controller.listPlugins({ mode: props.mode, sourceId: source.id }).length,
    }))];
  const index = Math.max(0, tabs.findIndex((tab) => tab.id === props.current));
  if (props.compact) {
    const tab = tabs[index]!;
    return <Text>来源  <Text color={tuiTheme.colors.accent}>[{tab.label}]</Text>  {index + 1} / {tabs.length}  ← →</Text>;
  }
  return (
    <Text>
      来源  {tabs.map((tab) => {
        const active = tab.id === props.current;
        const state = 'state' in tab ? tab.state : 'ready';
        return (
          <Text
            key={tab.id}
            bold={active}
            color={active ? tuiTheme.colors.accent
              : state === 'error' ? tuiTheme.statusColors.error
                : state === 'cache' ? tuiTheme.statusColors.warning : tuiTheme.colors.muted}
          >
            {active ? '[' : ''}{tab.label}{state === 'error' ? ' !' : ` ${tab.count ?? ''}`}{active ? ']' : ''}{'  '}
          </Text>
        );
      })}
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
  if (placement.state === 'scopeConflict') {
    return { value: '位置冲突', status: 'warning', description: '需要先处理两个安装位置' };
  }
  return {
    value: `${scopeLabel(placement.scope)} · ${placement.health === 'ready' ? '可用' : placement.health === 'incomplete' ? '需要处理' : '不可用'}`,
    status: placement.health === 'ready' ? 'success' : placement.health === 'incomplete' ? 'warning' : 'error',
    description: placement.health === 'ready' ? '当前检查正常' : '查看影响和建议操作',
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
  if (item.aggregateStatus !== 'ready') return aggregate.value;
  const ready = item.placements.filter((entry) => entry.state === 'installed' && entry.health === 'ready');
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
  if (route.name === 'installTools') {
    if (route.view === 'blocked') return 'D16';
    return controller.getPluginOverview(route.pluginId)?.dependencySummary?.totalCount ? 'D04' : 'P06';
  }
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
  const dependencyOperation = snapshot.activeReview?.operationKind === 'pluginWrite'
    && Boolean(snapshot.activeReview.changes.some((change) => change.group));
  if (route.name === 'review' && dependencyOperation) {
    return snapshot.activeReview?.pluginAction === 'uninstall' || snapshot.activeReview?.pluginAction === 'cleanup'
      ? 'D11' : 'D05';
  }
  if (route.name === 'progress' && snapshot.progressTargets.length > 0) return 'D06';
  if (route.name === 'result' && (snapshot.result?.state === 'succeeded' || snapshot.result?.state === 'partial')
    && snapshot.result.summary.targets?.some((target) => target.relation)) {
    return snapshot.result.state === 'partial' ? 'D08' : 'D07';
  }
  if (route.name === 'review' && snapshot.activeReview?.originIssue) return 'I10';
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
  if (route.name === 'configFields') return route.layer.scope === 'effective'
    ? 'C02' : route.groupId ? 'C04' : 'C03';
  if (route.name === 'configFieldEditor') return {
    enum: 'C05', boolean: 'C06', number: 'C07', string: 'C08', path: 'C09', sensitive: 'C10',
  }[route.editor] as ConsoleV4ScreenId;
  if (route.name === 'configPresets') return 'C11';
  if (route.name === 'configUnavailable') return 'C17';
  if (route.name === 'sourceList') return 'S01';
  if (route.name === 'sourceDetail') return 'S02';
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
      sourceDegraded: 'I04',
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
  const [searchMode, setSearchMode] = useState(false);
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<Scope>('user');
  const [tools, setTools] = useState<PlatformName[]>([]);
  const [technicalRouteKey, setTechnicalRouteKey] = useState<string>();
  const [exitAfterBusy, setExitAfterBusy] = useState(false);
  const [, setClockTick] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [configPage, setConfigPage] = useState<ConfigPageViewModel>();
  const [configLayerCounts, setConfigLayerCounts] = useState<Record<string, number>>({});
  const [configLoadKey, setConfigLoadKey] = useState(0);
  const [draftUpdates, setDraftUpdates] = useState<Record<string, string | number | boolean>>({});
  const [draftRemoves, setDraftRemoves] = useState<string[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [inputError, setInputError] = useState<string>();
  const [configActionError, setConfigActionError] = useState<string>();
  const [configResetAvailability, setConfigResetAvailability] = useState<Awaited<ReturnType<TuiController['getConfigResetAvailability']>>>();
  const [actionError, setActionError] = useState<string>();
  const [sourceDraft, setSourceDraft] = useState<SourceDraft>();
  const [sourceInput, setSourceInput] = useState('');
  const [sourceInputError, setSourceInputError] = useState<string>();
  const [sourceReferenceSummary, setSourceReferenceSummary] = useState<Awaited<ReturnType<TuiController['inspectSourceRemoval']>>>();
  const [sourceDependenciesExpanded, setSourceDependenciesExpanded] = useState(false);
  const [portableAgentInput, setPortableAgentInput] = useState('');
  const [draftOwner, setDraftOwner] = useState<string>();
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
    || route.name === 'configPresets'
    ? route
    : undefined;
  const currentConfigPage = configPageMatches(configPage, configRoute) ? configPage : undefined;
  useEffect(() => {
    if (route.name !== 'configLayer') return;
    const abort = new AbortController();
    const layers = [
      { key: 'effective', layer: { scope: 'effective' as const, projectLayer: 'shared' as const } },
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
      .catch(() => {
        if (!abort.signal.aborted) {
          const layer = configRoute.layer.scope === 'effective'
            ? undefined
            : { scope: configRoute.layer.scope as Scope, projectLayer: configRoute.layer.projectLayer };
          props.controller.replace({
            name: 'configUnavailable',
            pluginId: expectedPluginId,
            ...(layer ? { layer } : {}),
          });
        }
      });
    return () => abort.abort();
  }, [configLoadKey, configRoute?.pluginId, configRoute?.layer.scope, configRoute?.layer.projectLayer, props.controller]);

  useEffect(() => {
    if (route.name !== 'configUnavailable' || !route.layer) {
      setConfigResetAvailability(undefined);
      return;
    }
    const abort = new AbortController();
    void props.controller.getConfigResetAvailability(route.pluginId, route.layer)
      .then((availability) => {
        if (!abort.signal.aborted) setConfigResetAvailability(availability);
      })
      .catch(() => {
        if (!abort.signal.aborted) setConfigResetAvailability({ exists: false, sourceIdentityPresent: false });
      });
    return () => abort.abort();
  }, [props.controller, route.name, route.name === 'configUnavailable' ? route.pluginId : '', route.name === 'configUnavailable' ? JSON.stringify(route.layer) : '']);

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
      }).length;
      count = itemCount || 1;
    }
    if (count === undefined) return;
    setFocus((value) => Math.min(value, Math.max(0, count - 1)));
    const maximumVisible = policy.mode === 'compact' ? 4 : 6;
    setScrollOffset((value) => Math.min(value, Math.max(0, count - maximumVisible)));
  }, [
    policy.mode,
    props.controller,
    query,
    route.name,
    route.name === 'pluginList' ? route.mode : '',
    route.name === 'pluginList' ? route.sourceId : '',
    snapshot.viewModel,
  ]);

  const activeField = route.name === 'configFieldEditor'
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
    searchMode,
  );
  useEffect(() => {
    props.onScreenChange?.(screenId);
  }, [props.onScreenChange, screenId]);

  const selectedPlatforms = (candidate: PluginListItemViewModel | undefined, selectedScope: Scope): Array<{
    platform: PlatformName;
    disabled?: string;
  }> => (candidate?.supportedPlatforms ?? []).map((platform) => {
    const placement = props.controller.getPlatformPlacement(candidate!.pluginId, platform);
    if (!placement) return { platform, disabled: '当前没有可信的平台能力信息' };
    if (placement.state === 'scopeConflict') return { platform, disabled: '安装位置冲突；请先处理问题' };
    if (placement.state === 'installed') {
      return { platform, disabled: `已安装到${scopeLabel(placement.scope)}；请先移除现有安装` };
    }
    if (!placement.supportedScopes.includes(selectedScope)) return { platform, disabled: '不支持所选位置' };
    const overview = props.controller.getPluginDependencyOverview(candidate!.pluginId);
    for (const dependency of overview?.dependencies ?? []) {
      const dependentPlugin = props.controller.getPluginOverview(dependency.pluginId);
      if (!dependentPlugin || !dependentPlugin.supportedPlatforms.includes(platform)) {
        return { platform, disabled: `${dependency.displayName} 不支持${platformLabel(platform)}` };
      }
      const dependencyPlacement = props.controller.getPlatformPlacement(dependency.pluginId, platform);
      if (dependencyPlacement?.state === 'scopeConflict') {
        return { platform, disabled: `${dependency.displayName} 的安装位置冲突` };
      }
      if (dependencyPlacement?.state === 'installed') {
        if (dependencyPlacement.health !== 'ready') {
          return { platform, disabled: `${dependency.displayName} 需要先处理` };
        }
        if (selectedScope === 'user' && dependencyPlacement.scope === 'project') {
          return { platform, disabled: `${dependency.displayName} 只在当前项目可用` };
        }
      }
      if (dependencyPlacement?.state === 'notInstalled'
        && !dependencyPlacement.supportedScopes.includes(selectedScope)) {
        return { platform, disabled: `${dependency.displayName} 不支持所选位置` };
      }
    }
    return { platform };
  });

  const dependencyOverview = (candidate: PluginListItemViewModel | undefined): PluginDependencyOverviewViewModel | undefined =>
    candidate ? props.controller.getPluginDependencyOverview(candidate.pluginId) : undefined;

  const installIntent = (candidate: PluginListItemViewModel): OperationIntent => ({
    kind: 'pluginWrite',
    action: 'install',
    pluginId: candidate.pluginId,
    platform: tools.length === 2 ? 'both' : tools[0]!,
    scope,
  });

  let title = '管理你的 Agent 工作流插件';
  let description = '为 Codex 和 Claude Code 添加、设置或移除开发能力。';
  let breadcrumb = '首页';
  let context: string | undefined;
  let help = '↑↓ 移动 · Enter 选择 · ? 帮助 · q 退出';
  let content: React.ReactNode;
  let actions: ActionItem[] = [];

  const go = (next: TuiRoute): void => {
    props.controller.updatePageContext({ focusIndex: focus, scrollOffset, query, sourceTabId: route.name === 'pluginList' ? route.sourceId ?? 'all' : undefined });
    props.controller.push(next);
    setFocus(0);
    setScrollOffset(0);
    setSearchMode(false);
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
    setSearchMode(Boolean(restored.query));
    setActionError(undefined);
  };
  const leaveResult = (target?: TuiRoute): void => {
    props.controller.leaveResult(target);
    const restored = props.controller.snapshot.router.current.context;
    setFocus(restored.focusIndex ?? 0);
    setScrollOffset(restored.scrollOffset ?? 0);
    setQuery(restored.query ?? '');
    setSearchMode(Boolean(restored.query));
    setShowTechnical(false);
    setActionError(undefined);
  };
  const beginReview = async (intent: OperationIntent): Promise<void> => {
    const underlyingResultRoute = route.name === 'result' && snapshot.result && 'returnRoute' in snapshot.result
      ? snapshot.result.returnRoute
      : undefined;
    await props.controller.buildOperationReview(intent, underlyingResultRoute);
    setFocus(0);
    setScrollOffset(0);
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
  const beginPortableReview = async (pluginId: string, selectedScope: Scope): Promise<void> => {
    props.controller.setPortableScope(selectedScope);
    try {
      await props.controller.buildPortableInstallReview();
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
      if (field.sensitive || field.type === 'file' || field.type === 'directory') return '将更新';
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
  const fieldEditor = (field: ConfigFieldViewModel): Extract<TuiRoute, { name: 'configFieldEditor' }>['editor'] => {
    if (field.sensitive) return 'sensitive';
    if (field.type === 'file' || field.type === 'directory') return 'path';
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
  const configChanges = (): NonNullable<Extract<OperationIntent, { kind: 'configSave' }>['changes']> => {
    const fields = currentConfigPage?.groups.flatMap((group) => group.fields) ?? [];
    return [...Object.keys(draftUpdates), ...draftRemoves.filter((key) => !Object.hasOwn(draftUpdates, key))]
      .map((key) => {
        const field = fields.find((candidate) => candidate.key === key)!;
        return {
          key,
          title: field?.title ?? key,
          before: field?.displayValue ?? '未设置',
          after: draftRemoves.includes(key) ? '未设置' : currentFieldDisplay(field),
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
        privateKeys: fields.filter((field) => field.type === 'file' || field.type === 'directory').map((field) => field.key),
        changes: configChanges(),
      });
      setConfigActionError(undefined);
    } catch {
      setConfigActionError('设置值未通过验证。请重新检查修改。');
    }
  };

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
        {home.cachedSourceCount > 0 ? <ResultRow title={`${home.cachedSourceCount} 个来源使用缓存`} status="warning" /> : null}
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
    });
    breadcrumb = route.mode === 'browse' ? '添加插件' : '我的插件';
    title = breadcrumb;
    description = route.mode === 'browse' ? '选择希望 Agent 获得的能力。' : '查看状态，或选择一个插件进行管理。';
    context = `${items.length} 个插件`;
    help = '↑↓ 移动 · Enter 查看 · ←→ 来源 · / 搜索 · Esc 返回';
    const sourceError = sourceId !== 'all' && props.controller.getSourceOverview(sourceId).source?.state === 'error';
    actions = sourceError
      ? [{ label: '查看来源问题', description: '没有可用缓存；当前不能浏览这个来源', run: () => go({ name: 'issueDetail', issueId: `source:${sourceId}:unavailable` }) }]
      : items.map((item) => ({
          label: item.displayName,
          description: `${item.description}${sourceId === 'all' ? ` · ${item.sourceLabel}` : ''}`,
          meta: statusText(item),
          status: item.aggregateStatus === 'needsAttention' ? 'warning'
            : item.aggregateStatus === 'installed' ? 'success'
              : item.aggregateStatus === 'unavailable' ? 'error' : 'muted',
          run: () => go(route.mode === 'browse'
            ? { name: 'pluginPreview', pluginId: item.pluginId }
            : { name: 'pluginDetail', pluginId: item.pluginId }),
        }));
    if (route.mode === 'installed' && items.length === 0 && !sourceError) {
      title = '还没有添加插件';
      description = `从已配置的 ${props.controller.listSources().length} 个来源中浏览可用能力。`;
      actions = [{ label: '浏览插件', description: '开始添加第一个插件', run: () => go({ name: 'pluginList', mode: 'browse' }) }];
    }
    const viewport = actionViewport(route.name, actions, policy.mode, focus, scrollOffset);
    content = (
      <Box flexDirection="column">
        <SourceTabs controller={props.controller} current={sourceId} compact={policy.mode === 'compact'} mode={route.mode} />
        <Text color={searchMode ? tuiTheme.colors.accent : tuiTheme.colors.muted}>/ {searchMode ? query || '输入搜索内容' : '搜索名称、用途或来源…'}</Text>
        {sourceError
          ? <Callout status="error" title={`${sourceId} 暂时无法提供插件`} description="没有可用缓存，因此当前不能浏览这个来源。" />
          : route.mode === 'installed' && items.length === 0
            ? <Callout title="开始添加第一个插件" description="插件可以安装到 Codex、Claude Code 或两者。" />
            : null}
        <SemanticRows
          actions={actions}
          focus={focus}
          kind={sourceError || items.length === 0 ? 'action' : 'plugin'}
          compact={policy.mode === 'compact'}
          offset={viewport.offset}
          limit={viewport.limit}
        />
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
        selectedPlatforms(plugin, candidateScope).some((entry) => !entry.disabled)) ?? scope;
      const available = selectedPlatforms(plugin, initialScope)
        .filter((entry) => !entry.disabled).map((entry) => entry.platform);
      setScope(initialScope);
      setTools(available);
      if (available.length > 0) go({ name: 'installPlacement', pluginId: plugin.pluginId });
      else go({ name: 'installTools', pluginId: plugin.pluginId, view: 'blocked' });
    };
    const portableAction: ActionItem[] = plugin.portableSkills
      ? [{ label: '安装通用 Skills…', description: '选择 Skill 和 Agent 后交给 Skills CLI 安装', run: () => beginPortable(plugin.pluginId) }]
      : [];
    actions = hasDependencies && (overview?.blockers.length ?? 0) > 0
      ? [
          { label: '查看依赖问题', description: overview!.blockers[0]!.explanation, status: 'warning', run: () => go({ name: 'pluginDependencies', pluginId: plugin.pluginId }) },
          ...portableAction,
          { label: '查看依赖关系', description: '查看直接、间接依赖和当前状态', run: () => go({ name: 'pluginDependencies', pluginId: plugin.pluginId }) },
          { label: '查看插件设置定义', description: `${plugin.configFieldCount} 个配置字段`, run: () => go({ name: 'configLayer', pluginId: plugin.pluginId }) },
        ]
      : [
          { label: '添加插件', description: '选择使用位置并确认变化', run: beginInstall },
          ...portableAction,
          ...(hasDependencies ? [{ label: '查看依赖关系', description: '查看直接、间接依赖和当前状态', run: () => go({ name: 'pluginDependencies', pluginId: plugin.pluginId }) }] : []),
          { label: '查看插件设置定义', description: `${plugin.configFieldCount} 个配置字段`, run: () => go({ name: 'configLayer', pluginId: plugin.pluginId }) },
          { label: '查看来源', run: () => go({ name: 'sourceDetail', sourceId: plugin.sourceId }) },
        ];
    const summaryRows = (relation: 'direct' | 'transitive'): React.ReactNode[] => {
      const dependencies = overview?.dependencies.filter((entry) => entry.relation === relation) ?? [];
      const visible = dependencies.slice(0, policy.mode === 'compact' ? 1 : 2);
      return [
        ...visible.map((entry) => {
          const state = dependencyStatus(entry);
          return <StaticRow
            key={entry.pluginId}
            title={entry.displayName}
            description={dependencyRelationDescription(entry)}
            meta={state.value}
            status={state.status}
            compact={policy.mode === 'compact'}
          />;
        }),
        ...(dependencies.length > visible.length
          ? [<StaticRow key={`${relation}:more`} title={`另有 ${dependencies.length - visible.length} 个${relation === 'direct' ? '直接' : '间接'}依赖`} status="muted" compact />]
          : []),
      ];
    };
    const compactDependencyRows = overview?.dependencies.slice(0, 2) ?? [];
    content = hasDependencies
      ? <Box flexDirection="column">
          {plugin.portableSkills && policy.mode !== 'compact' ? <SectionCard title="可用方式"><StaticRow title="通用 Skills" meta={`可安装 · ${plugin.dependencySummary!.totalCount} 个插件依赖`} description="选择 Skill 和 Agent 后交给 Skills CLI 安装" /></SectionCard> : null}
          <SectionCard title="安装内容">
            <StaticRow title={plugin.displayName} description="你选择的插件" status="info" />
            {plugin.portableSkills && policy.mode === 'compact' ? <StaticRow title="通用 Skills" meta={`可安装 · ${plugin.dependencySummary!.totalCount} 个插件依赖`} compact /> : null}
            {policy.mode === 'compact' ? compactDependencyRows.map((entry) => {
              const state = dependencyStatus(entry);
              return <StaticRow key={entry.pluginId} title={entry.displayName} meta={`${entry.relation === 'direct' ? '直接' : '间接'} · ${state.value}`} status={state.status} compact />;
            }) : <>{summaryRows('direct')}{summaryRows('transitive')}</>}
            {policy.mode === 'compact' && (overview?.dependencies.length ?? 0) > compactDependencyRows.length ? <StaticRow title={`另有 ${(overview?.dependencies.length ?? 0) - compactDependencyRows.length} 个依赖`} status="muted" compact /> : null}
            <StaticRow title={`${plugin.dependencySummary!.totalCount + 1} 个插件将作为一个安装计划检查`} description="依赖从同一个来源快照解析。" compact={policy.mode === 'compact'} />
          </SectionCard>
          <SemanticRows actions={actions} focus={focus} kind="action" compact={policy.mode === 'compact'} />
        </Box>
      : <Box flexDirection="column"><SectionCard title="可用工具"><StaticRow title={plugin.supportedPlatforms.map(platformLabel).join(' · ') || '暂无可用工具'} />{plugin.portableSkills ? <StaticRow title="通用 Skills" meta="可安装" description="选择 Skill 和 Agent 后交给 Skills CLI 安装" compact={policy.mode === 'compact'} /> : null}</SectionCard><SectionCard title="使用说明"><StaticRow title="在 Agent 会话中提供能力" status="success" description="安装不会自动修改项目源码。" /></SectionCard><SemanticRows actions={actions} focus={focus} kind="action" compact={policy.mode === 'compact'} /></Box>;
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
    const viewport = portableSkillCandidateViewport(
      candidateActions,
      draft.candidates,
      policy.mode,
      focus,
      scrollOffset,
    );
    const visibleCandidateEntries = draft.candidates
      .map((candidate, index) => ({ candidate, action: candidateActions[index]!, index }))
      .slice(viewport.offset, viewport.offset + viewport.limit);
    const providerGroups = [...new Map(visibleCandidateEntries.map((entry) => [
      entry.candidate.providerPluginId,
      visibleCandidateEntries.filter((candidate) => candidate.candidate.providerPluginId === entry.candidate.providerPluginId),
    ])).values()];
    const variantCandidates = draft.candidates.filter(portableScopeVariantsDiffer);
    help = '↑↓ 移动 · Space 切换 · a 全选 · Enter 继续 · Esc 返回';
    content = <Box flexDirection="column">
      {providerGroups.map((entries) => {
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
      <Callout status="warning" title={`! ${variantCandidates.length} 个 Skill 在不同安装范围会生成不同内容。选择范围后会重新确认最终内容。`} />
      <SemanticRows actions={actions} focus={focus} kind="action" compact offset={draft.candidates.length} />
      {showTechnical && variantCandidates.length > 0 ? <TechnicalDetails title="范围变体">
        {variantCandidates.flatMap((candidate) => [
          <StaticRow key={`${candidate.name}:project`} title={`${candidate.name} · ${portableScopeVariantLabel('project', candidate.scopeDetails.project)}`} compact />,
          <StaticRow key={`${candidate.name}:user`} title={`${candidate.name} · ${portableScopeVariantLabel('user', candidate.scopeDetails.user)}`} compact />,
        ])}
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
    const visibleDependencies = dependencies.slice(0, policy.mode === 'compact' ? 2 : 5);
    content = <Box flexDirection="column">
      <SectionCard title="当前插件" meta="根 provider"><StaticRow title={plugin.displayName} description="提供本次安装入口" meta={`贡献 ${snapshot.portableDraft.candidates.filter((candidate) => candidate.relation === 'requested').length} 个 Skills`} compact={policy.mode === 'compact'} /></SectionCard>
      <SectionCard title="依赖 providers" meta={`${dependencies.length} 个`}>
        {visibleDependencies.map((dependency) => <StaticRow key={dependency.pluginId} title={dependency.displayName} description={`${dependency.relation === 'direct' ? '根 provider 的直接依赖' : '依赖链中的间接 provider'} · ${dependency.requiredBy.map((entry) => entry.displayName).join('、')} 需要它`} meta={`贡献 ${snapshot.portableDraft!.candidates.filter((candidate) => candidate.providerPluginId === dependency.pluginId).length} 个 Skills`} compact={policy.mode === 'compact'} />)}
        {dependencies.length > visibleDependencies.length ? <StaticRow title={`另有 ${dependencies.length - visibleDependencies.length} 个依赖 provider`} status="muted" compact /> : null}
      </SectionCard>
      <SemanticRows actions={actions} focus={focus} kind="action" compact />
      {showTechnical ? <TechnicalDetails>{dependencies.map((entry) => <StaticRow key={entry.pluginId} title={entry.displayName} meta={entry.pluginId} compact />)}</TechnicalDetails> : null}
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
    content = <Box flexDirection="column"><InputCard focused title={portableAgentInput || ' '} description={inputError ?? 'Enter 保存并继续 · Esc 返回；q 和 b 会作为输入。'} status={inputError ? 'error' : undefined} /><StaticRow title="示例" meta="cursor, claude-code, codex" status="muted" compact /></Box>;
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
    title = route.code === 'requiredConfigMissing' ? '无法准备通用 Skills'
      : route.code === 'portableScopeUnavailable' ? '所选范围不可用'
      : route.code === 'portableSkillsCliMissing' || route.code === 'portableSkillsCliIncompatible' ? '暂时无法安装通用 Skills' : '无法准备通用 Skills';
    description = route.code === 'requiredConfigMissing' ? '插件缺少生成内容所需的设置。'
      : route.code === 'portableScopeUnavailable' ? '至少一个所选 Skill 不适用于这个范围。请返回 Skill 选择或更改范围。'
      : route.code === 'portableSkillsCliMissing' || route.code === 'portableSkillsCliIncompatible' ? '没有找到兼容的 Skills CLI。' : '候选 Skill 没有通过 Portable 校验。';
    actions = [
      ...(route.code === 'requiredConfigMissing' ? [{ label: '完成插件设置', run: () => {
        props.controller.replace({ name: 'configLayer', pluginId: plugin.pluginId });
        setFocus(0);
        setScrollOffset(0);
      } }] : []),
      ...(route.code === 'portableSkillsCliMissing' || route.code === 'portableSkillsCliIncompatible'
        ? [{ label: '查看安装说明', run: () => setShowTechnical((value) => !value) }] : []),
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
    ];
    const blockerImpact = route.code === 'requiredConfigMissing'
      ? '缺少生成 Skill 所需的设置；没有调用 Skills CLI。'
      : route.code === 'portableSkillsCliMissing' || route.code === 'portableSkillsCliIncompatible'
        ? '当前不能开始安装；插件和现有 Skills 保持不变。'
        : route.code === 'portableScopeUnavailable'
          ? '所选内容不能在这个范围完整生成；没有开始写入。'
          : '候选内容没有通过安全校验；没有开始写入。';
    description = '';
    content = <Box flexDirection="column">
      <StatusCard status="error" title={title} description={blockerImpact} />
      <Callout status="warning" title="安全恢复" description={route.code === 'requiredConfigMissing' ? '完成插件设置后重新准备。' : route.code === 'portableSkillsCliMissing' || route.code === 'portableSkillsCliIncompatible' ? '安装或升级兼容的 Skills CLI 后重新检查。' : '返回修改选择，或修复来源内容后重新检查。'} />
      <SemanticRows actions={actions} focus={focus} kind="action" compact={policy.mode === 'compact'} />
      {showTechnical ? <TechnicalDetails>
        <StaticRow title={route.code === 'portableSkillsCliMissing' || route.code === 'portableSkillsCliIncompatible' ? '兼容版本：Skills CLI >=1.5.23 <2.0.0' : `诊断代码：${route.diagnosticCode}`} compact />
      </TechnicalDetails> : <StaticRow title="d 查看脱敏诊断" status="muted" compact />}
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
    const dependentLimit = policy.mode === 'compact' ? 2 : 4;
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
      ];
      content = <Box flexDirection="column">
        <Callout status="error" title={`${dependentCount} 个已安装插件仍在使用`} description="没有修改任何安装。" />
        <SectionCard title="使用这个依赖的插件" meta="反向引用">
          {dependencyRows(visibleDependents, dependentLimit, true)}
        </SectionCard>
        <SemanticRows actions={actions} focus={focus} kind="action" compact={policy.mode === 'compact'} />
      </Box>;
    } else {
      breadcrumb = `${plugin.displayName} / 依赖关系`;
      context = overview ? `${overview.summary.totalCount + 1} 个插件` : '只读';
      title = hasInstalledPlacement(plugin) ? '依赖与被使用情况' : '安装所需插件';
      description = '依赖从同一个来源快照解析；关系页不会修改安装。';
      actions = [
        { label: '技术详情', description: '显示 canonical pluginId 和安全错误代码', run: () => setShowTechnical((value) => !value) },
      ];
      const rootStatus = plugin.aggregateStatus === 'installed' ? 'success' as const
        : plugin.aggregateStatus === 'needsAttention' ? 'warning' as const
          : plugin.aggregateStatus === 'unavailable' ? 'error' as const : 'muted' as const;
      const compactDependencies = overview?.dependencies.slice(0, dependentCount > 0 ? 1 : 2) ?? [];
      const compactDependents = visibleDependents.slice(0, 1);
      content = <Box flexDirection="column">
        {policy.mode === 'compact' ? <SectionCard title="依赖关系">
          <StaticRow title={`根插件 · ${plugin.displayName}`} meta={statusText(plugin)} status={rootStatus} compact />
          {compactDependencies.map((entry) => { const state = dependencyStatus(entry); return <StaticRow key={entry.pluginId} title={`必需依赖 · ${entry.displayName}`} meta={dependencyPlacementLabel(entry)} status={state.status} compact />; })}
          {dependencyCount > compactDependencies.length ? <StaticRow title={`必需依赖 · 另有 ${dependencyCount - compactDependencies.length} 项`} status="muted" compact /> : null}
          {compactDependents.map((entry) => { const state = dependencyStatus(entry); return <StaticRow key={entry.pluginId} title={`被依赖 · ${entry.displayName}`} meta={dependentTargetLabel(entry)} status={state.status} compact />; })}
          {dependentCount > compactDependents.length ? <StaticRow title={`被依赖 · 另有 ${dependentCount - compactDependents.length} 项`} status="muted" compact /> : null}
          {overview?.blockers.map((blocker) => <StaticRow key={blocker.code} title={`阻塞 · ${blocker.title}`} description={blocker.explanation} status="error" compact />)}
          {dependencyCount + dependentCount === 0 ? <StaticRow title="没有可显示的依赖关系" status="muted" compact /> : null}
        </SectionCard> : <>
          <SectionCard title="你选择的插件" meta="根节点"><StaticRow title={plugin.displayName} meta={statusText(plugin)} status={rootStatus} /></SectionCard>
          {dependencyCount > 0 ? <SectionCard title="必需依赖" meta="依赖优先">{dependencyRows(overview?.dependencies ?? [], dependencyLimit)}</SectionCard> : null}
          {dependentCount > 0 ? <SectionCard title="使用它的插件" meta="反向引用">{dependencyRows(visibleDependents, dependentLimit, true)}</SectionCard> : null}
          {overview?.blockers.map((blocker) => <Callout key={blocker.code} status="error" title={blocker.title} description={blocker.explanation} />)}
          {dependencyCount + dependentCount === 0 ? <Callout status="muted" title="没有可显示的依赖关系" /> : null}
        </>}
        <SemanticRows actions={actions} focus={focus} kind="action" compact={policy.mode === 'compact'} />
        {showTechnical ? <TechnicalDetails><StaticRow title="canonical pluginId" meta={plugin.pluginId} />{overview?.dependencies.slice(0, policy.mode === 'compact' ? 2 : 5).map((entry) => <StaticRow key={entry.pluginId} title={entry.pluginId} description={dependencyRelationDescription(entry)} compact={policy.mode === 'compact'} />)}</TechnicalDetails> : null}
      </Box>;
    }
  } else if (route.name === 'installPlacement' && plugin) {
    breadcrumb = `${plugin.displayName} / 添加`;
    context = '第 1 步，共 2 步';
    title = `你希望在哪里使用 ${plugin.displayName}？`;
    const overview = dependencyOverview(plugin);
    const hasDependencies = (plugin.dependencySummary?.totalCount ?? 0) > 0;
    description = hasDependencies
      ? '根插件和缺失依赖使用同一个位置；健康的所有项目依赖可在当前项目复用。'
      : '工具已根据插件能力自动选择；需要时可以调整。';
    const availableScopes = (['user', 'project'] as const).filter((candidateScope) =>
      selectedPlatforms(plugin, candidateScope).some((entry) => !entry.disabled));
    const reusableDependencies = overview?.dependencies.filter((dependency) => dependency.placements.some((placement) =>
      placement.state === 'installed' && placement.health === 'ready'
        && (scope === 'project' || placement.scope === 'user'))).length ?? 0;
    const missingDependencies = Math.max(0, (overview?.summary.totalCount ?? 0) - reusableDependencies);
    actions = [
      ...availableScopes.map((candidateScope) => ({
        label: scopeLabel(candidateScope),
        selected: candidateScope === scope,
        description: candidateScope === 'user'
          ? hasDependencies ? '根插件和缺失依赖都可在任意项目中使用' : '在任意项目中可使用，适合个人常用能力'
          : hasDependencies ? '缺失依赖添加到当前项目；已有所有项目依赖会复用' : '仅在当前项目中使用，适合团队共享',
        meta: candidateScope === 'user' ? '推荐' : undefined,
        run: () => {
          setScope(candidateScope);
          setTools(selectedPlatforms(plugin, candidateScope).filter((entry) => !entry.disabled).map((entry) => entry.platform));
        },
      })),
      { label: '继续', disabled: tools.length === 0 ? '没有可安装的工具' : undefined, run: async () => beginReview(installIntent(plugin)) },
      { label: '调整工具…', run: () => {
        const choices = selectedPlatforms(plugin, scope);
        go({ name: 'installTools', pluginId: plugin.pluginId,
          ...(choices.every((choice) => choice.disabled) ? { view: 'blocked' as const } : {}) });
      } },
    ];
    content = <Box flexDirection="column">
      <SemanticRows actions={actions.slice(0, availableScopes.length)} focus={focus} kind="choice" compact={policy.mode === 'compact'} />
      {hasDependencies ? <SectionCard title="依赖处理"><StaticRow title={`${reusableDependencies} 个依赖会复用现有安装`} status={reusableDependencies > 0 ? 'success' : 'muted'} /><StaticRow title={`${missingDependencies} 个依赖将安装到所选位置`} status={missingDependencies > 0 ? 'info' : 'muted'} /></SectionCard> : null}
      <SectionCard title="可用工具"><StaticRow title={tools.map(platformLabel).join('、') || '当前没有可用工具'} meta="已自动选择" /></SectionCard>
      <SemanticRows actions={actions.slice(availableScopes.length)} focus={focus - availableScopes.length} kind="action" compact={policy.mode === 'compact'} />
    </Box>;
  } else if (route.name === 'installTools' && plugin) {
    breadcrumb = `${plugin.displayName} / 添加 / 工具`;
    context = '可选';
    title = '选择要添加到哪些工具';
    const hasDependencies = (plugin.dependencySummary?.totalCount ?? 0) > 0;
    description = hasDependencies
      ? '只有根插件和所有依赖都支持所选位置的工具才可选择。'
      : '同一插件、同一平台只能安装到一个位置。';
    const choices = selectedPlatforms(plugin, scope);
    const allUnavailable = choices.length > 0 && choices.every((choice) => choice.disabled);
    if (route.view === 'blocked' || allUnavailable) {
      context = '依赖限制';
      title = '无法添加到所选工具';
      description = '根插件或必需依赖不支持当前工具组合，因此不会进入确认页。';
      actions = [
        { label: '查看依赖关系', run: () => go({ name: 'pluginDependencies', pluginId: plugin.pluginId }) },
        { label: '返回调整位置', run: back },
      ];
      content = <Box flexDirection="column"><StatusCard status="warning" title="所选工具不可用">{choices.map((choice) => <StaticRow key={choice.platform} title={platformLabel(choice.platform)} description={choice.disabled ? `不可选 · ${choice.disabled}` : '不可选'} status="muted" compact={policy.mode === 'compact'} />)}</StatusCard><SemanticRows actions={actions} focus={focus} kind="action" compact={policy.mode === 'compact'} /></Box>;
    } else {
      actions = choices.map((choice) => ({
        label: platformLabel(choice.platform),
        selected: tools.includes(choice.platform),
        description: choice.disabled ?? '当前未安装，支持所选位置',
        meta: tools.includes(choice.platform) ? '已选择' : undefined,
        disabled: choice.disabled,
        run: () => {
          setDirty(true);
          setTools((current) => current.includes(choice.platform)
            ? current.filter((platform) => platform !== choice.platform)
            : [...current, choice.platform]);
        },
      }));
      help = '↑↓ 移动 · Space 切换 · Enter 完成 · Esc 返回';
      content = <Box flexDirection="column"><SemanticRows actions={actions} focus={focus} kind="toggle" compact={policy.mode === 'compact'} />{hasDependencies ? <Callout title="工具兼容性" description="不兼容的工具不能选择；请查看依赖关系了解原因。" /> : null}<Callout status={tools.length > 0 ? 'info' : 'warning'} title={tools.length > 0 ? 'Enter 完成选择' : '至少选择一个工具'} /></Box>;
    }
  } else if (route.name === 'pluginDetail' && plugin) {
    breadcrumb = `我的插件 / ${plugin.displayName}`;
    context = `${plugin.sourceLabel}${plugin.version ? ` · ${plugin.version}` : ''}`;
    title = plugin.displayName;
    description = plugin.description;
    const dependencySummary = plugin.dependencySummary;
    const placementActions = plugin.installedPlacements.map((placement) => {
      const projected = placementStatus(placement);
      return {
        label: platformLabel(placement.platform),
        description: projected.description,
        meta: projected.value,
        status: projected.status,
        run: () => placement.state === 'scopeConflict'
          ? go({ name: 'issueDetail', issueId: `scope:${plugin.pluginId}:${placement.platform}` })
          : go({ name: 'platform', pluginId: plugin.pluginId, platform: placement.platform }),
      };
    });
    const dependencyActions = dependencySummary ? [{
      label: '必需依赖',
      description: dependencySummary.issueCount > 0 ? `${dependencySummary.issueCount} 项需要处理` : '查看直接、间接依赖和被使用情况',
      meta: dependencySummaryText(dependencySummary),
      status: dependencySummary.issueCount > 0 ? 'warning' as const : undefined,
      run: () => go({ name: 'pluginDependencies', pluginId: plugin.pluginId }),
    }] : [];
    const portableActions = plugin.portableSkills ? [{
      label: '通用 Skills',
      description: '选择 Skill 和 Agent 后交给 Skills CLI 安装',
      meta: dependencySummary ? `可安装 · ${dependencySummary.totalCount} 个插件依赖` : '可安装',
      run: () => beginPortable(plugin.pluginId),
    }] : [];
    actions = [
      ...placementActions,
      ...dependencyActions,
      ...portableActions,
      { label: '设置', description: '个人默认、当前项目和本机覆盖', meta: `${plugin.configFieldCount} 项配置`, run: () => go({ name: 'configLayer', pluginId: plugin.pluginId }) },
      { label: '关于与技术详情', description: '版本、来源和受管内容', run: () => go({ name: 'pluginAbout', pluginId: plugin.pluginId }) },
    ];
    const dependencyOffset = placementActions.length;
    const portableOffset = dependencyOffset + dependencyActions.length;
    const settingOffset = portableOffset + portableActions.length;
    content = <Box flexDirection="column"><SectionCard title="使用状态"><SemanticRows actions={placementActions} focus={focus} kind="section" compact={policy.mode === 'compact'} /></SectionCard>{dependencySummary ? <SectionCard title="依赖关系"><SemanticRows actions={dependencyActions} focus={focus - dependencyOffset} kind="section" compact={policy.mode === 'compact'} /></SectionCard> : null}{plugin.portableSkills ? <SectionCard title="通用 Skills" description="选择 Skill 和 Agent 后交给 Skills CLI 安装"><ActionRow title="安装通用 Skills…" meta={portableActions[0]?.meta} focused={focus === portableOffset} compact /></SectionCard> : null}<SectionCard title="插件设置"><SemanticRows actions={actions.slice(settingOffset, -1)} focus={focus - settingOffset} kind="section" compact={policy.mode === 'compact'} /></SectionCard><SemanticRows actions={actions.slice(-1)} focus={focus - actions.length + 1} kind="action" compact={policy.mode === 'compact'} /></Box>;
  } else if (route.name === 'platform' && plugin) {
    const placement = props.controller.getPlatformPlacement(plugin.pluginId, route.platform);
    breadcrumb = `${plugin.displayName} / ${platformLabel(route.platform)}`;
    if (plugin.aggregateStatus === 'unavailable') {
      title = `暂时无法管理 ${platformLabel(route.platform)}`;
      description = '插件来源不可用，当前状态不能安全确认。';
      actions = [{ label: '查看来源问题', description: `${plugin.sourceId} 无可用缓存`, run: () => go({ name: 'issueDetail', issueId: `source:${plugin.sourceId}:unavailable` }) }, { label: '重新检查状态', description: '不会修改现场内容', run: () => props.controller.refreshSource(plugin.sourceId) }];
      content = <Box flexDirection="column"><StatusCard status="error" title="来源不可用" description="插件设置保持不变" /><SemanticRows actions={actions} focus={focus} kind="action" compact={policy.mode === 'compact'} /></Box>;
    } else if (!placement || placement.state === 'notInstalled') {
      title = `尚未添加到 ${platformLabel(route.platform)}`;
      description = '此插件支持所列使用位置。';
      actions = [{ label: `添加到 ${platformLabel(route.platform)}…`, description: '选择使用位置', run: () => {
        const initialScope = placement?.state === 'notInstalled'
          ? placement.supportedScopes[0] ?? scope
          : scope;
        setScope(initialScope);
        setTools([route.platform]);
        go({ name: 'installPlacement', pluginId: plugin.pluginId });
      } }, { label: '查看支持信息', description: 'manifest 与平台能力', run: () => go({ name: 'pluginAbout', pluginId: plugin.pluginId }) }];
      content = <Box flexDirection="column"><StatusCard status="muted" title="未添加" description="插件设置保持不变" /><SemanticRows actions={actions} focus={focus} kind="action" compact={policy.mode === 'compact'} /></Box>;
    } else if (placement.state === 'scopeConflict') {
      title = '安装位置冲突';
      description = '正常状态只能保留一个位置。';
      actions = [{ label: '查看位置冲突问题', run: () => go({ name: 'issueDetail', issueId: `scope:${plugin.pluginId}:${route.platform}` }) }];
      content = <SemanticRows actions={actions} focus={focus} kind="action" compact={policy.mode === 'compact'} />;
    } else if (placement.health === 'error') {
      const typedIssue = props.controller.listUserIssues().find((candidate) =>
        candidate.pluginId === plugin.pluginId
        && candidate.platform === route.platform
        && candidate.scope === placement.scope);
      title = `${platformLabel(route.platform)} 暂时不可管理`;
      description = typedIssue?.explanation ?? '平台状态检查失败，当前不能安全选择写操作。';
      actions = [
        ...(typedIssue ? [{ label: '查看对应问题', description: typedIssue.title, run: () => go({ name: 'issueDetail', issueId: typedIssue.issueId }) }] : []),
        { label: '查看安全技术详情', description: '只显示类型化状态和错误码', run: () => go({ name: 'pluginTechnical', pluginId: plugin.pluginId }) },
        { label: '返回插件', run: back },
      ];
      content = <Box flexDirection="column"><StatusCard status="error" title="状态检查失败" description="当前只提供只读操作" /><SemanticRows actions={actions} focus={focus} kind="action" compact={policy.mode === 'compact'} /></Box>;
    } else if (placement.health === 'incomplete') {
      title = `${platformLabel(route.platform)} ${placement.health === 'incomplete' ? '安装不完整' : '暂时不可用'}`;
      description = '缺少一项必要内容，插件可能无法稳定启动。';
      actions = [
        { label: '重新连接缺失内容…', description: '保留现有设置', run: () => beginReview({ kind: 'pluginWrite', action: 'reinstall', pluginId: plugin.pluginId, platform: route.platform, scope: placement.scope }) },
        { label: '查看影响', description: '缺少的内容和范围', run: () => go({ name: 'pluginTechnical', pluginId: plugin.pluginId }) },
        { label: `从${scopeLabel(placement.scope)}移除…`, description: '保留插件设置', status: 'error', run: () => beginPluginRemoval(plugin, route.platform, placement.scope) },
      ];
      content = <Box flexDirection="column"><StatusCard status="warning" title="需要处理" description={`${scopeLabel(placement.scope)} · ${plugin.sourceLabel}`} /><SemanticRows actions={actions} focus={focus} kind="action" compact={policy.mode === 'compact'} /></Box>;
    } else {
      title = `已安装到${scopeLabel(placement.scope)}`;
      description = `当前检查正常${plugin.version ? `；版本 ${plugin.version}` : ''}。`;
      actions = [
        { label: '运行升级…', description: '使用当前来源中的版本重建', run: () => beginReview({ kind: 'pluginWrite', action: 'upgrade', pluginId: plugin.pluginId, platform: route.platform, scope: placement.scope }) },
        { label: '重新安装…', description: '重新生成并验证受管内容', run: () => beginReview({ kind: 'pluginWrite', action: 'reinstall', pluginId: plugin.pluginId, platform: route.platform, scope: placement.scope }) },
        { label: `从${scopeLabel(placement.scope)}移除…`, description: '保留插件设置', status: 'error', run: () => beginPluginRemoval(plugin, route.platform, placement.scope) },
        { label: '查看安装详情', description: '组件与诊断信息', run: () => go({ name: 'pluginTechnical', pluginId: plugin.pluginId }) },
      ];
      content = <Box flexDirection="column"><StatusCard status="success" title="状态正常" description={`${scopeLabel(placement.scope)}${plugin.version ? ` · 当前版本 ${plugin.version}` : ''}`} /><SemanticRows actions={actions} focus={focus} kind="action" compact={policy.mode === 'compact'} /></Box>;
    }
  } else if (route.name === 'configLayer' && plugin) {
    breadcrumb = `${plugin.displayName} / 设置`;
    title = '选择要查看或修改的设置';
    description = '安装位置与设置保存层是两个不同概念。';
    help = '↑↓ 移动 · Enter 打开 · Esc 返回';
    actions = [
      { label: '有效设置', description: '合并后的实际结果 · 只读', meta: '查看', run: () => go({ name: 'configFields', pluginId: plugin.pluginId, layer: { scope: 'effective', projectLayer: 'shared' } }) },
      { label: '个人默认', description: '在所有项目中作为默认值', meta: configLayerCounts.user === undefined ? undefined : `${configLayerCounts.user} 个值`, run: () => go({ name: 'configFields', pluginId: plugin.pluginId, layer: { scope: 'user', projectLayer: 'shared' } }) },
      { label: '当前项目', description: '随仓库共享，适合团队约定', meta: configLayerCounts.project === undefined ? undefined : `${configLayerCounts.project} 个值`, run: () => go({ name: 'configFields', pluginId: plugin.pluginId, layer: { scope: 'project', projectLayer: 'shared' } }) },
      { label: '当前项目（仅本机）', description: '只保存在本机，不提交到仓库', meta: configLayerCounts.local === undefined ? undefined : configLayerCounts.local === 0 ? '未设置' : `${configLayerCounts.local} 个值`, run: () => go({ name: 'configFields', pluginId: plugin.pluginId, layer: { scope: 'project', projectLayer: 'local' } }) },
    ];
    content = <SemanticRows actions={actions} focus={focus} kind="section" compact={policy.mode === 'compact'} />;
  } else if (route.name === 'configFields' && plugin) {
    const readonly = route.layer.scope === 'effective';
    const selectedGroups = route.groupId
      ? currentConfigPage?.groups.filter((group) => group.id === route.groupId) ?? []
      : currentConfigPage?.groups ?? [];
    breadcrumb = `${plugin.displayName} / 设置 / ${configLayerLabel(route.layer)}`;
    context = readonly ? '只读' : dirty ? `${Object.keys(draftUpdates).length + draftRemoves.length} 项未保存` : undefined;
    title = readonly ? '当前实际使用的设置' : route.groupId ? selectedGroups[0]?.title ?? '高级设置' : configLayerLabel(route.layer);
    description = readonly ? '由默认值、个人默认、当前项目和本机覆盖合并。' : route.groupId ? '这些字段来自 manifest 的高级设置分组。' : '字段来自插件 manifest；修改先保存在本地草稿。';
    if (!readonly && configActionError) description = configActionError;
    help = readonly ? '↑↓ 查看 · Esc 返回' : '↑↓ 移动 · Enter 修改 · s 保存 · u 恢复继承 · Esc 返回';
    if (!currentConfigPage) {
      content = <StatusCard status="info" title="正在读取可信设置定义"><ProgressRow title="读取 manifest 设置字段" state="active" /></StatusCard>;
    } else if (readonly) {
      actions = selectedGroups.flatMap((group) => group.fields.map((field) => ({
        label: field.title,
        description: `来自${field.sourceLabel}`,
        meta: currentFieldDisplay(field),
      })));
      const limit = policy.mode === 'compact' ? 4 : 7;
      content = <SectionCard title="有效设置">{actions.slice(scrollOffset, scrollOffset + limit).map((action, index) => <StaticRow key={`${action.label}:${index}`} title={action.label} description={action.description} meta={action.meta} compact={policy.mode === 'compact'} />)}</SectionCard>;
    } else {
      const mutableLayer = {
        scope: route.layer.scope as Scope,
        projectLayer: route.layer.projectLayer,
      };
      const rowGroups: Array<{ id: string; title: string; rows: ActionItem[] }> = [];
      if (!route.groupId && currentConfigPage.presets.length > 0) {
        rowGroups.push({ id: 'presets', title: '快速方案', rows: [{ label: '当前方案', description: '应用 manifest 声明的预设', meta: `${currentConfigPage.presets.length} 个`, run: () => go({ name: 'configPresets', pluginId: plugin.pluginId, layer: mutableLayer }) }] });
      }
      for (const group of selectedGroups) {
        const rows: ActionItem[] = group.advanced && !route.groupId
          ? [{ label: group.title, description: group.description ?? '渐进展开高级字段', meta: `${group.fields.length} 项`, run: () => go({ name: 'configFields', pluginId: plugin.pluginId, layer: route.layer, groupId: group.id }) }]
          : group.fields.map((field) => ({
              label: field.title,
              description: field.description,
              meta: currentFieldDisplay(field),
              configKey: field.key,
              run: () => go({ name: 'configFieldEditor', pluginId: plugin.pluginId, layer: mutableLayer, fieldKey: field.key, editor: fieldEditor(field) }),
            }));
        rowGroups.push({ id: group.id, title: group.advanced && !route.groupId ? '高级设置' : group.title, rows });
      }
      actions = rowGroups.flatMap((group) => group.rows);
      if (!route.groupId) actions.push(
        { label: '保存修改', description: dirty ? '查看安全变更汇总' : '当前没有未保存修改', disabled: dirty ? undefined : '当前没有未保存修改', run: beginConfigSave },
        {
          label: '重置此设置层…',
          description: '删除本层全部值并恢复继承',
          status: 'error',
          disabled: currentConfigPage.storedCount === 0 ? '本层没有已存值' : undefined,
          run: () => beginReview({ kind: 'configReset', pluginId: plugin.pluginId, scope: route.layer.scope as Scope, projectLayer: route.layer.projectLayer }),
        },
      );
      let rowOffset = 0;
      content = policy.mode === 'compact' || scrollOffset > 0
        ? <SectionCard title="设置字段"><SemanticRows actions={actions} focus={focus} kind={focus < rowGroups.reduce((count, group) => count + group.rows.length, 0) ? 'section' : 'action'} compact offset={scrollOffset} limit={policy.mode === 'compact' ? 4 : 7} /></SectionCard>
        : <Box flexDirection="column">{rowGroups.map((group) => {
        const offset = rowOffset;
        rowOffset += group.rows.length;
        return <SectionCard key={group.id} title={group.title}><SemanticRows actions={actions} focus={focus} kind="section" compact offset={offset} limit={group.rows.length} /></SectionCard>;
      })}{!route.groupId ? <SemanticRows actions={actions} focus={focus} kind="action" offset={rowOffset} /> : null}</Box>;
    }
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
      title = route.editor === 'number' ? `输入${activeField.title}` : route.editor === 'path' ? `选择${activeField.title}` : route.editor === 'sensitive' ? '输入敏感值' : `输入${activeField.title}`;
      description = route.editor === 'number'
        ? `允许范围：${activeField.min ?? '不限'}–${activeField.max ?? '不限'}${activeField.unit ? ` ${activeField.unit}` : ''}。`
        : route.editor === 'path' ? `${activeField.type === 'file' ? '文件' : '目录'}路径会在保存前由现有 schema 路径验证。`
          : route.editor === 'sensitive' ? '当前值不会回显；留空不会自动删除旧值。' : activeField.description ?? '';
      const visibleInput = route.editor === 'sensitive'
        ? '•'.repeat(inputValue.length)
        : route.editor === 'path' ? privatePathInput(inputValue) : inputValue;
      content = <InputCard focused title={visibleInput || activeField.placeholder || ' '} description={inputError ?? (route.editor === 'sensitive' ? '输入已隐藏。' : route.editor === 'path' ? '已隐藏父目录；Backspace 仍会编辑原始输入。' : activeField.placeholder ?? '按 Enter 使用输入值。')} status={inputError ? 'error' : undefined} />;
    }
  } else if (route.name === 'configPresets' && plugin) {
    breadcrumb = `${plugin.displayName} / 设置 / 预设`;
    title = '选择快速方案';
    description = '预设由插件 manifest 声明；应用后仍可逐项修改。';
    actions = (currentConfigPage?.presets ?? []).map((preset) => ({
      label: preset.title,
      description: (preset.privateFieldTitles?.length ?? 0) > 0
        ? `${preset.description ? `${preset.description} · ` : ''}${preset.privateFieldTitles!.join('、')}需手动输入`
        : preset.description,
      run: () => {
        const fields = new Map(currentConfigPage?.groups.flatMap((group) => group.fields)
          .map((field) => [field.key, field]));
        const nextUpdates = { ...draftUpdates };
        for (const [key, value] of Object.entries(preset.values)) {
          const field = fields.get(key);
          if (field?.configured && field.value === value) delete nextUpdates[key];
          else nextUpdates[key] = value;
        }
        const nextRemoves = draftRemoves.filter((key) => !Object.hasOwn(preset.values, key));
        setDraftUpdates(nextUpdates);
        setDraftRemoves(nextRemoves);
        setDirty(Object.keys(nextUpdates).length + nextRemoves.length > 0);
        back();
      },
    }));
    content = currentConfigPage ? <SemanticRows actions={actions} focus={focus} kind="choice" compact={policy.mode === 'compact'} /> : <StatusCard status="info" title="正在读取预设"><ProgressRow title="读取 manifest 预设" state="active" /></StatusCard>;
  } else if (route.name === 'configUnavailable' && plugin) {
    breadcrumb = `${plugin.displayName} / 设置`;
    context = '暂时不可编辑';
    title = '暂时无法编辑设置';
    description = '当前无法取得可信的字段定义，因此不能验证新值。';
    actions = [
      { label: '重新检查来源', description: '刷新当前来源后重新读取可信定义', run: async () => {
        await props.controller.refreshSource(plugin.sourceId);
        setConfigLoadKey((value) => value + 1);
        props.controller.replace({ name: 'configFields', pluginId: plugin.pluginId, layer: route.layer ?? { scope: 'user', projectLayer: 'shared' } });
      } },
      ...(configResetAvailability?.sourceIdentityPresent
        ? [{ label: '技术详情', description: '查看可信身份和设置层摘要', run: () => setShowTechnical((value) => !value) }]
        : []),
      { label: '返回', run: back },
    ];
    content = <Box flexDirection="column"><Callout status="error" title="Manifest 或来源不可用" description="已保存的设置保持不变。恢复来源后才能编辑或重置。" />{showTechnical && configResetAvailability?.sourceIdentityPresent ? <TechnicalDetails><Text>来源身份：{configResetAvailability.sourceIdentity}</Text><Text>设置摘要：{configResetAvailability.storeDigest}</Text></TechnicalDetails> : null}<SemanticRows actions={actions} focus={focus} kind="action" compact={policy.mode === 'compact'} /></Box>;
  } else if (route.name === 'sourceList') {
    breadcrumb = '插件来源';
    title = '插件来源';
    description = '单个来源失败不会阻止其他来源继续工作。';
    context = `${props.controller.listSources().length} 个来源`;
    help = '↑↓ 移动 · Enter 打开 · r 重新检查 · Esc 返回';
    actions = [
      ...props.controller.listSources().map((source) => {
        const overview = props.controller.getSourceOverview(source.id);
        const health = overview.health?.state ?? source.state;
        const status = health === 'ready' ? '已从远端加载'
          : health === 'path' ? '本地目录'
            : health === 'checking' ? '正在检查'
              : health === 'cache' || health === 'degraded' ? '使用缓存' : '无法读取';
        return {
          label: `${source.id}${source.primary ? '  主来源' : ''}`,
          description: `${overview.detail?.type === 'path' ? '本地目录' : 'Git 仓库'} · ${source.count ?? 0} 个插件`,
          meta: status,
          status: health === 'unavailable' ? 'error' as const
            : health === 'cache' || health === 'degraded' ? 'warning' as const
              : source.primary ? 'success' as const : undefined,
          run: () => go({ name: 'sourceDetail', sourceId: source.id }),
        };
      }),
      { label: '＋ 添加来源', description: 'Git 仓库或本地目录', run: beginAddSource },
    ];
    const viewport = actionViewport(route.name, actions, policy.mode, focus, scrollOffset);
    const sourceCount = Math.max(0, actions.length - 1);
    content = <Box flexDirection="column"><SemanticRows actions={actions} focus={focus} kind={focus < sourceCount ? 'section' : 'action'} compact={policy.mode === 'compact'} offset={viewport.offset} limit={viewport.limit} /></Box>;
  } else if (route.name === 'sourceDetail') {
    const overview = props.controller.getSourceOverview(route.sourceId);
    const detail = overview.detail;
    const state = overview.health?.state ?? overview.source?.state;
    breadcrumb = `插件来源 / ${route.sourceId}`;
    context = detail?.type === 'path' ? '本地目录' : 'Git';
    title = route.sourceId;
    description = state === 'cache' || state === 'degraded' ? '当前使用已缓存的 Catalog 数据。'
      : state === 'unavailable' ? '当前无法读取这个来源。' : '来源状态可用。';
    help = '↑↓ 移动 · Enter 选择 · r 重新检查 · Esc 返回';
    actions = [
      { label: '重新检查来源', description: '读取远端并更新缓存', run: () => props.controller.refreshSource(route.sourceId) },
      { label: '编辑来源…', description: 'ID 与类型创建后不可修改', run: () => go({ name: 'sourceEdit', sourceId: route.sourceId }) },
      { label: '设为主来源…', description: '只改变默认 marketplace', disabled: detail?.primary ? '当前已经是主来源' : undefined, run: () => beginReview({ kind: 'sourceMutation', action: 'setPrimary', sourceId: route.sourceId, changes: [{ title: '主来源', before: snapshot.viewModel?.sourceTabs.find((source) => source.primary)?.id, after: route.sourceId }] }) },
      { label: '移除来源…', description: '移除来源配置', status: 'error', disabled: detail?.primary ? '主来源不能直接移除' : undefined, run: () => beginReview({ kind: 'sourceMutation', action: 'remove', sourceId: route.sourceId, changes: [{ title: `移除来源 ${route.sourceId}` }] }) },
      { label: '技术详情', description: '只读身份与解析证据', run: () => go({ name: 'sourceTechnical', sourceId: route.sourceId }) },
    ];
    const sourceActionViewport = actionViewport(route.name, actions, policy.mode, focus, scrollOffset);
    content = <Box flexDirection="column"><StatusCard status={state === 'unavailable' ? 'error' : state === 'cache' || state === 'degraded' ? 'warning' : 'success'} title={state === 'checking' ? '正在检查' : state === 'unavailable' ? '无法读取' : state === 'cache' || state === 'degraded' ? '使用缓存' : '可用'} /><SectionCard title="来源配置"><StaticRow title="位置" meta={detail?.locationSummary ?? '不可用'} /><StaticRow title="插件" meta={`${detail?.pluginCount ?? 0} 个`} />{policy.mode === 'compact' ? null : <><StaticRow title="版本选择" meta={detail?.type === 'path' ? '本地目录' : detail?.refPolicy === 'explicit' ? '固定 Git 引用' : '跟随 AW 版本通道'} />{detail?.explicitRef ? <StaticRow title="引用" meta={detail.explicitRef} /> : null}</>}</SectionCard><SemanticRows actions={actions} focus={focus} kind="action" compact={policy.mode === 'compact'} offset={sourceActionViewport.offset} limit={sourceActionViewport.limit} /></Box>;
  } else if (route.name === 'sourceTechnical') {
    const detail = props.controller.getSourceOverview(route.sourceId).detail;
    breadcrumb = `插件来源 / ${route.sourceId} / 技术详情`;
    context = '只读';
    title = '来源身份与解析详情';
    description = '用于诊断和安全审查；不显示认证信息或绝对路径。';
    content = <TechnicalDetails><StaticRow title="sourceId" meta={route.sourceId} /><StaticRow title="sourceIdentity" meta={detail?.sourceIdentity ?? '不可用'} /><StaticRow title="requestedRef" meta={detail?.requestedRef ?? '不可用'} />{detail?.resolvedCommit ? <StaticRow title="resolvedCommit" meta={detail.resolvedCommit} /> : null}<StaticRow title="freshness" meta={detail?.freshness ?? '不可用'} /><StaticRow title="configDigest" meta={detail?.configDigest ?? '不可用'} /></TechnicalDetails>;
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
      title = '选择版本引用方式'; description = '跟随 AW 通道适合常规来源；固定 ref 适合测试来源。';
      actions = [
        { label: '跟随 AW 版本通道', description: '自动选择 catalog/latest 或 catalog/beta', run: async () => { const next = { ...sourceDraft, refPolicy: 'cliChannel' as const, ref: '' }; setSourceDraft(next); if (next.mode === 'update') await beginSourceUpdateReview(next); else go({ name: 'sourceAdd', step: 'subdir', owner: route.owner }); } },
        { label: '固定 Git 引用', description: 'branch、tag 或 commit', run: () => { setSourceDraft({ ...sourceDraft, refPolicy: 'explicit' }); go({ name: 'sourceAdd', step: 'ref', owner: route.owner }); } },
      ]; content = <SemanticRows actions={actions} focus={focus} kind="choice" compact={policy.mode === 'compact'} />;
    } else {
      title = route.step === 'id' ? '输入来源 ID' : route.step === 'location' ? `输入 ${sourceDraft.type === 'git' ? 'Git URL' : '绝对路径'}` : route.step === 'ref' ? '输入固定 Git 引用' : '输入 Catalog 子目录';
      description = route.step === 'subdir' ? '仓库根目录是 Catalog 时保持为空。' : '输入会在继续前按来源规范验证。';
      const displayedInput = route.step === 'location' && sourceDraft.type === 'git' && sourceInput
        ? projectCatalogSourceLocation(sourceInput)
        : route.step === 'location' && sourceDraft.type === 'path'
          ? privatePathInput(sourceInput)
          : sourceInput;
      content = <InputCard focused title={displayedInput || ' '} description={sourceInputError ?? (route.step === 'location' && sourceDraft.type === 'path' ? '已隐藏父目录；Backspace 仍会编辑原始输入。' : '按 Enter 继续。')} status={sourceInputError ? 'error' : undefined} />;
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
    actions = detail?.type === 'git' ? [
      { label: 'Git URL', description: detail.locationSummary, run: () => startEdit('location') },
      { label: '版本引用', description: detail.refPolicy === 'explicit' ? `固定：${detail.explicitRef}` : '跟随 AW 版本通道', run: () => startEdit('refPolicy') },
      { label: 'Catalog 子目录', description: detail.subdir ?? '未设置', run: () => startEdit('subdir') },
    ] : [{ label: '本地目录', description: '已选择本地目录', run: () => startEdit('location') }];
    content = <SemanticRows actions={actions} focus={focus} kind="section" compact={policy.mode === 'compact'} />;
  } else if (route.name === 'sourceRemoveBlocked') {
    breadcrumb = `插件来源 / ${route.sourceId} / 移除`;
    context = '已阻止'; title = `无法移除 ${route.sourceId}`;
    description = sourceReferenceSummary?.inventoryComplete === false ? '引用清单不完整，不能把未知引用当作零。' : '仍有内容依赖这个来源。';
    actions = [{ label: sourceDependenciesExpanded ? '收起依赖内容' : '查看依赖内容', description: '只显示插件、来源、平台、位置和类别聚合', run: () => setSourceDependenciesExpanded((value) => !value) }, { label: '返回来源详情', run: back }];
    const countLabel = (value: number | undefined, unit: string): string => value === undefined ? '未知' : `${value} ${unit}`;
    content = <Box flexDirection="column"><Callout status="error" title={sourceReferenceSummary?.inventoryComplete === false ? '引用清单不完整' : '发现活动引用'} /><SectionCard title="引用汇总"><StaticRow title="安装位置" meta={countLabel(sourceReferenceSummary?.installationCount, '个')} /><StaticRow title="插件设置" meta={countLabel(sourceReferenceSummary?.configCount, '份')} /><StaticRow title="生命周期状态" meta={countLabel(sourceReferenceSummary?.lifecycleCount, '个')} /><StaticRow title="Marketplace" meta={countLabel(sourceReferenceSummary?.marketplaceCount, '个')} />{sourceDependenciesExpanded ? sourceReferenceSummary?.dependencies.slice(0, policy.mode === 'compact' ? 2 : 5).map((dependency, index) => <StaticRow key={`${dependency.category}:${dependency.pluginId ?? dependency.sourceId ?? index}`} title={`${dependency.category} · ${dependency.pluginId ?? dependency.sourceId ?? '身份未知'}`} meta={`${dependency.platform ? platformLabel(dependency.platform) : ''}${dependency.scope ? ` · ${scopeLabel(dependency.scope)}` : ''}`} />) : null}</SectionCard><SemanticRows actions={actions} focus={focus} kind="action" compact={policy.mode === 'compact'} /></Box>;
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
        status: entry.category === 'sourceDegraded' ? 'warning' as const : 'error' as const,
        run: () => entry.category === 'dependencyStillRequired' && entry.pluginId
          ? go({ name: 'pluginDependencies', pluginId: entry.pluginId, view: 'removeBlocked',
              ...(entry.platform ? { platform: entry.platform } : {}),
              ...(entry.scope ? { scope: entry.scope } : {}) })
          : go({ name: 'issueDetail', issueId: entry.issueId }),
      }));
    }
    const viewport = actionViewport(route.name, actions, policy.mode, focus, scrollOffset);
    content = <SemanticRows actions={actions} focus={focus} kind={issues.length > 0 ? 'task' : 'action'} compact={policy.mode === 'compact'} offset={viewport.offset} limit={viewport.limit} />;
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
      if (entry.id === 'refreshSource' && issue.sourceId) await props.controller.refreshSource(issue.sourceId);
      else if (entry.id === 'continueWithCache' || entry.id === 'retryLater') go({ name: 'issueList' });
      else if (entry.id === 'editSource' && issue.sourceId) go({ name: 'sourceDetail', sourceId: issue.sourceId });
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
    actions = issue.actions.map((entry) => ({
      label: entry.label,
      description: entry.description,
      status: entry.id === 'remove'
        || entry.id === 'keepUserScope' || entry.id === 'keepProjectScope' ? 'error' as const : undefined,
      run: () => runIssueAction(entry),
    }));
    const issuePlugin = issue.pluginId ? props.controller.getPluginOverview(issue.pluginId) : undefined;
    const issueOverview = issue.pluginId ? props.controller.getPluginDependencyOverview(issue.pluginId) : undefined;
    const manualMigration = issue.category === 'legacyState' && showTechnical;
    if (issue.category === 'dependencyStillRequired' && issuePlugin) {
      const blockingDependents = issue.platform && issue.scope
        ? props.controller.getBlockingDependents(issuePlugin.pluginId, issue.platform, issue.scope)
        : issueOverview?.dependents ?? [];
      title = `无法移除 ${issuePlugin.displayName}`;
      description = '仍有插件依赖它。没有提供危险绕过操作。';
      actions = [
        { label: '查看完整依赖关系', run: () => go({ name: 'pluginDependencies', pluginId: issuePlugin.pluginId }) },
        { label: '返回插件详情', run: () => go({ name: 'pluginDetail', pluginId: issuePlugin.pluginId }) },
      ];
      content = <Box flexDirection="column"><Callout status="error" title={`${blockingDependents.length} 个已安装插件仍在使用`} /><SectionCard title="使用这个依赖的插件">{blockingDependents.map((dependent) => <StaticRow key={dependent.pluginId} title={dependent.displayName} meta={dependentTargetLabel(dependent)} />)}</SectionCard><SemanticRows actions={actions} focus={focus} kind="action" compact={policy.mode === 'compact'} /></Box>;
    } else if ((issue.category === 'dependencyMissing' || issue.category === 'dependencyNotReady') && issuePlugin) {
      const dependencyName = issue.dependencyPluginId
        ? props.controller.getPluginOverview(issue.dependencyPluginId)?.displayName ?? issue.dependencyPluginId
        : '必需依赖';
      const dependencyTarget = [
        issue.dependencyPlatform ? platformLabel(issue.dependencyPlatform) : undefined,
        issue.dependencyScope ? scopeLabel(issue.dependencyScope) : undefined,
      ].filter((entry): entry is string => Boolean(entry)).join(' · ');
      content = <Box flexDirection="column">
        <StatusCard status="warning" title={dependencyName} description={issue.explanation}>
          <StaticRow title={issuePlugin.displayName} description="受影响的根插件" meta={issue.platform && issue.scope ? `${platformLabel(issue.platform)} · ${scopeLabel(issue.scope)}` : undefined} />
          {dependencyTarget ? <StaticRow title="依赖目标" meta={dependencyTarget} status="warning" /> : null}
        </StatusCard>
        <SectionCard title="影响范围">{issue.impact.map((line) => <StaticRow key={line} title={line} compact={policy.mode === 'compact'} />)}</SectionCard>
        <SemanticRows actions={actions} focus={focus} kind="action" compact={policy.mode === 'compact'} />
      </Box>;
    } else if (issue.category === 'dependencyTargetUnsupported' && issuePlugin) {
      const compatible = selectedPlatforms(issuePlugin, issue.scope ?? scope).filter((entry) => !entry.disabled);
      title = `无法添加到 ${issue.platform ? platformLabel(issue.platform) : '所选工具'}`;
      description = issue.dependencyPluginId
        ? `${props.controller.getPluginOverview(issue.dependencyPluginId)?.displayName ?? issue.dependencyPluginId} 不支持所选工具，因此完整插件计划不能运行。`
        : '完整插件计划不支持所选工具。';
      actions = [
        ...compatible.map((entry) => ({ label: `只添加到 ${platformLabel(entry.platform)}`, description: '返回位置页并使用完整依赖检查', run: () => {
          setScope(issue.scope ?? scope);
          setTools([entry.platform]);
          go({ name: 'installPlacement', pluginId: issuePlugin.pluginId });
        } })),
        { label: '返回调整工具', run: () => go({ name: 'installTools', pluginId: issuePlugin.pluginId }) },
        { label: '查看依赖关系', run: () => go({ name: 'pluginDependencies', pluginId: issuePlugin.pluginId }) },
      ];
      content = <Box flexDirection="column"><Callout status="error" title={issue.dependencyPluginId ? `${props.controller.getPluginOverview(issue.dependencyPluginId)?.displayName ?? issue.dependencyPluginId} 不支持所选工具` : '工具不兼容'} description="可用工具仍保持可选，不兼容工具不会进入确认页。" /><SemanticRows actions={actions} focus={focus} kind="action" compact={policy.mode === 'compact'} /></Box>;
    } else if (issue.category === 'dependencyGraphInvalid') {
      title = `暂时无法添加 ${issuePlugin?.displayName ?? issue.pluginId ?? '插件'}`;
      description = '来源中的依赖关系无效或安装记录不能安全验证。没有修改任何安装。';
      content = <Box flexDirection="column"><Callout status="error" title={issue.rootCode ?? issue.category} description={issue.explanation} /><SemanticRows actions={actions} focus={focus} kind="action" compact={policy.mode === 'compact'} />{showTechnical ? <TechnicalDetails>{issue.technicalDetails.map((detail, index) => <StaticRow key={`${detail.code}:${index}`} title={detail.code} description={detail.message} compact={policy.mode === 'compact'} />)}</TechnicalDetails> : <StaticRow title="d 查看安全错误代码" status="muted" />}</Box>;
    } else {
      const sourceMissingCleanup = issue.category === 'sourceMissing' && issue.pluginId && issue.platform && issue.scope
        ? `aw cleanup ${issue.pluginId} --platform ${issue.platform} --scope ${issue.scope}`
        : undefined;
      content = <Box flexDirection="column"><SectionCard title="影响范围">{issue.impact.map((line) => <StaticRow key={line} title={line} />)}{sourceMissingCleanup ? <><Text color={tuiTheme.statusColors.warning}>可清理可信的 AW 现场：</Text><Text>{sourceMissingCleanup}</Text><Text color={tuiTheme.statusColors.warning}>如需跳过 dependent 保护，在命令末尾添加 --force。</Text></> : null}{issue.category === 'sourceIdentityChanged' ? <Callout status="warning" title="来源身份已变化" description="请确认来源变更，或恢复原 identity；当前不自动迁移或清理。" /> : null}{issue.placements ? <StaticRow title="位置" meta={issue.placements.map(scopeLabel).join('、')} /> : null}{issue.requiredFields ? <StaticRow title="字段" meta={issue.requiredFields.map((field) => field.title).join('、')} /> : null}</SectionCard><SemanticRows actions={actions} focus={focus} kind="action" compact={policy.mode === 'compact'} offset={policy.mode === 'compact' ? scrollOffset : undefined} limit={policy.mode === 'compact' ? 4 : 7} />{manualMigration ? <TechnicalDetails title="手动处理说明"><StaticRow title="1. 不自动迁移旧版状态。" /><StaticRow title="2. 运行 aw status --json，记录公开错误 code。" /><StaticRow title="3. 备份相关 AW 配置。" /><StaticRow title="4. 按技术详情使用受支持命令或人工处理。" /><StaticRow title="5. 再次运行状态检查。" /></TechnicalDetails> : showTechnical ? <TechnicalDetails>{issue.technicalDetails.map((detail, index) => <StaticRow key={`${detail.code}:${index}`} title={detail.code} description={detail.message} compact={policy.mode === 'compact'} />)}</TechnicalDetails> : <StaticRow title="d 或“技术详情”查看安全错误代码" status="muted" />}</Box>;
    }
  } else if (route.name === 'review' && snapshot.activeReview) {
    const review = snapshot.activeReview;
    breadcrumb = `${review.subject.name} / ${review.title}`;
    title = `${snapshot.result?.state === 'stale' ? '状态已变化 · ' : ''}${review.operationKind === 'portableInstall' ? review.title : `确认${review.title}`} ${review.subject.name}`;
    description = snapshot.result?.state === 'stale' ? '当前状态已变化。请检查新的变化后再次确认。' : review.description;
    actions = [
      { label: review.primaryLabel, description: '执行前将再次检查当前状态', status: review.destructive ? 'error' : undefined, run: () => {
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
    const groupTitle = {
      requested: review.operationKind === 'portableInstall' ? '已选择 Skills · 当前插件' : '你选择的插件',
      dependencies: review.operationKind === 'portableInstall' ? '已选择 Skills · 来自依赖插件' : '必需依赖',
      portableTarget: '安装目标',
      portableInputs: '准备内容',
      portableWarnings: '覆盖冲突',
      preserved: '保持不变',
    } as const;
    const changeStatus = (change: OperationReviewChange): ActionItem['status'] =>
      change.kind === 'remove' ? 'error'
        : change.kind === 'warning' ? 'warning'
          : change.kind === 'keep' || change.kind === 'add' ? 'success' : undefined;
    const groupOrder = ['portableWarnings', 'portableTarget', 'requested', 'dependencies', 'preserved', 'portableInputs'] as const;
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
    const headingLines = policy.mode === 'compact' ? 0 : visibleSpecs.filter((group) => group.label).length;
    const staticRowBudget = Math.max(visibleSpecs.length, (policy.mode === 'compact' ? 7 : 12) - headingLines);
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
        {policy.mode !== 'compact' && group.label ? <Text bold color={tuiTheme.colors.muted}>{group.label}</Text> : null}
        {group.changes.slice(0, visibleCount).map((change, index) => {
          const retainDescription = change.kind === 'warning' || group.key === 'portableTarget'
            || group.key === 'requested' || group.key === 'dependencies';
          const description = retainDescription ? change.description : undefined;
          const compactGroupLabel = group.key === 'requested' ? '根插件'
            : group.key === 'dependencies' ? '依赖'
              : group.key === 'preserved' ? '保持' : group.label;
          const category = policy.mode === 'compact' && index === 0 && compactGroupLabel ? `${compactGroupLabel} · ` : '';
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
    content = <Box flexDirection="column"><ReviewCard title={review.subject.name} meta={`${review.subject.sourceLabel} ${review.subject.version ?? ''}`} description={review.equivalentCommand ? review.description : undefined}>{review.equivalentCommand ? <Text>等价命令：{review.equivalentCommand}</Text> : null}{changeGroups}<SemanticRows actions={actions} focus={focus} kind="action" compact />{policy.mode === 'compact' ? null : <StaticRow title="技术详情（d）" status="muted" />}{showTechnical ? <TechnicalDetails>{review.technicalDetails?.map((detail) => <StaticRow key={detail} title={detail} compact />)}</TechnicalDetails> : null}</ReviewCard></Box>;
  } else if (route.name === 'progress') {
    const portableOperation = snapshot.activeReview?.operationKind === 'portableInstall';
    const configOperation = snapshot.activeReview?.operationKind === 'configSave'
      || snapshot.activeReview?.operationKind === 'configReset';
    const sourceOperation = snapshot.activeReview?.operationKind === 'sourceMutation';
    const issueOperation = snapshot.activeReview?.originIssue;
    breadcrumb = portableOperation ? '通用 Skills / 进度' : issueOperation ? '需要处理 / 进度' : sourceOperation ? '插件来源 / 保存' : configOperation ? '设置 / 进度' : '插件操作 / 进度';
    title = portableOperation ? '正在安装通用 Skills' : issueOperation ? '正在处理问题' : sourceOperation ? '正在保存并刷新来源' : configOperation ? '正在保存并应用设置' : '正在执行插件操作';
    description = issueOperation ? '完成后会使用新的状态 generation 重新检查问题。' : sourceOperation ? '先原子保存来源配置，再尽力刷新。刷新失败时配置仍保留并显示警告。' : configOperation ? '先保存所选层，再重新应用当前可见安装位置。' : '请勿关闭当前终端。';
    help = 'd 技术进度 · Ctrl-C 完成后退出';
    const progress = snapshot.progress;
    const elapsedSeconds = Math.max(0, Math.floor(((progress.elapsedMs
      ?? (progress.startedAtMs === undefined ? 0 : Date.now() - progress.startedAtMs))) / 1_000));
    const latestMessage = progress.messages.at(-1);
    const technicalMessages = progress.messages.slice(-4);
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
    const visibleProgressTargets = prioritizedProgressTargets.slice(0, policy.mode === 'compact' ? 2 : 5);
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
    content = portableOperation ? <StatusCard status={failedProgress ? 'error' : 'info'} title="Skills CLI">
      <ProgressRow title="检查插件和依赖" description={`${snapshot.activeReview?.subject.name ?? '当前插件'} · ${portableDraft?.dependencySummary?.directCount ?? 0} 个直接依赖`} meta={portableProgressMeta(0)} state={portableProgressState(0)} />
      <ProgressRow title="生成已选候选 Skills" description={`${portableProviderCount} 个 provider 提供 ${portableSelectedCount} 个 Skills`} meta={portableProgressMeta(1)} state={portableProgressState(1)} />
      <ProgressRow title={`安装已选择的 ${portableSelectedCount} 个 Skills`} description={`Agent：${portableDraft?.agentMode === 'explicit' ? portableDraft.requestedAgents.join('、') : 'Skills CLI 默认选择'}`} meta={portableProgressMeta(2)} state={portableProgressState(2)} />
      <ProgressRow title="验证结果" description="逐项确认所选 Skill 的安装目标" meta={portableProgressMeta(3)} state={portableProgressState(3)} />
      {showTechnical ? <TechnicalDetails>{technicalMessages.map((message, index) => <StaticRow key={`${index}:${message}`} title={message} compact />)}</TechnicalDetails> : null}
    </StatusCard> : <StatusCard status="info">
      {dependencyProgress ? <>
        <ProgressRow title="检查依赖关系" state={relationStep} />
        <ProgressRow title="生成执行计划" state={planStep} />
        <ProgressRow title="执行依赖闭包" description={progress.current?.target ? `当前：${progress.current.target}` : undefined} meta={`${elapsedSeconds}s`} state={closureStep} compact={policy.mode === 'compact'} />
        <ProgressRow title="验证完整结果" state={verificationStep} />
      </> : <>
        <ProgressRow title={sourceOperation ? '检查来源操作输入' : configOperation ? '验证设置值' : '检查兼容性'} state={!currentPhase ? 'pending' : preflightActive ? 'active' : 'complete'} />
        <ProgressRow title={progress.current?.phase || (sourceOperation ? '保存来源配置并刷新' : configOperation ? '保存设置层并重新应用' : '连接到所选工具')} description={progress.current?.target ? `当前：${progress.current.target}` : undefined} meta={`${elapsedSeconds}s`} state={failedProgress ? 'error' : executionActive ? 'active' : validationActive ? 'complete' : 'pending'} compact={policy.mode === 'compact'} />
        <ProgressRow title="验证结果" state={failedProgress ? 'error' : validationActive ? 'active' : 'pending'} />
      </>}
      {dependencyProgress ? <SectionCard title="执行目标" meta={`${snapshot.progressTargets.length} 个目标`}>{visibleProgressTargets.map((entry) => {
        const state = progressLabel(entry);
        const relation = entry.relation === 'requested' ? '你选择的插件' : entry.relation === 'direct' ? '直接依赖' : '间接依赖';
        const title = props.controller.getPluginOverview(entry.pluginId)?.displayName
          ?? entry.pluginId.split('/').at(-1);
        return <ResultRow key={`${entry.pluginId}:${entry.platform}:${entry.scope}`} title={title} description={relation} meta={state.label} status={state.status ?? 'muted'} compact={policy.mode === 'compact'} />;
      })}{hiddenProgressTargets > 0 ? <StaticRow title={`另有 ${hiddenProgressTargets} 个目标`} status="muted" compact /> : null}</SectionCard> : null}
      {!showTechnical && latestMessage ? <StaticRow title={latestMessage} status="muted" compact /> : null}
      {showTechnical ? technicalMessages.map((message, index) => <StaticRow key={`${index}:${message}`} title={message} compact />) : null}
      {exitAfterBusy ? <Callout status="warning" title="操作完成后退出" /> : null}
    </StatusCard>;
  } else if (route.name === 'result' && snapshot.result) {
    const result = snapshot.result;
    const partial = result.state === 'partial';
    const blocked = result.state === 'blocked';
    breadcrumb = '插件操作 / 结果';
    const action = result.state === 'succeeded' || result.state === 'partial'
      ? result.summary.action
      : undefined;
    const operationKind = 'operationKind' in result ? result.operationKind : undefined;
    const portableOperation = operationKind === 'portableInstall';
    const portableReceipt = result.state === 'succeeded' || result.state === 'partial'
      ? result.summary.portable : undefined;
    const portableInstallFailed = portableReceipt?.failureCode === 'portableSkillsCliInstallFailed';
    const portableOriginIsDetail = 'returnRoute' in result
      && result.returnRoute?.name === 'pluginDetail';
    const configOperation = operationKind === 'configSave' || operationKind === 'configReset'
      ? operationKind : undefined;
    const sourceOperation = operationKind === 'sourceMutation';
    const sourceRefreshWarning = sourceOperation && 'summary' in result
      && result.summary.messages?.some((message) => message.startsWith('警告：'));
    const issueOperation = result.originIssue;
    const completedTitle = {
      install: '✓ 插件添加完成',
      upgrade: '✓ 插件升级完成',
      reinstall: '✓ 插件重新安装完成',
      uninstall: '✓ 插件移除完成',
      cleanup: '✓ 插件清理完成',
    }[action ?? 'install'];
    title = portableOperation
      ? blocked ? '× 通用 Skills 安装被阻止'
        : partial ? '! 通用 Skills 结果未完全完成' : '✓ 通用 Skills 已安装'
      : blocked && result.writeMayHaveCompleted
      ? '× 写入结果未确认'
      : issueOperation
      ? blocked || partial ? '× 问题仍未解决' : '✓ 问题已处理'
      : sourceOperation
      ? blocked ? '× 来源操作未完成' : sourceRefreshWarning ? '! 来源配置已保存，但刷新失败' : '✓ 来源操作完成'
      : configOperation
      ? blocked
        ? '× 设置未确认保存'
        : partial ? '! 设置已保存，但部分应用失败' : '✓ 设置已保存并应用'
      : partial ? '! 插件操作只完成了一部分' : blocked ? '× 插件操作未完成' : completedTitle;
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
          ? '来源配置可能已保存。请重新检查来源列表；刷新失败不会撤销配置。'
          : '来源操作未执行。草稿已保留，可返回修改。'
        : sourceRefreshWarning
          ? '来源配置已保留。请根据警告修复来源后重试刷新。'
          : '来源配置已保存，刷新已完成。'
      : blocked ? result.message
        : configOperation ? '设置层已经更新。' : '状态已刷新。';
    const completedResult = result.state === 'succeeded' || result.state === 'partial'
      ? result
      : undefined;
    const pluginId = completedResult?.summary.pluginId
      ?? ('pluginId' in result ? result.pluginId : undefined);
    const failedTarget = completedResult?.summary.targets
      ?.filter((target) => target.state === 'failed')
      .sort((left, right) => [left.pluginId ?? '', left.platform, left.scope].join('\0')
        .localeCompare([right.pluginId ?? '', right.platform, right.scope].join('\0'), 'en'))[0];
    const failedPluginId = failedTarget?.pluginId ?? pluginId;
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
      : issueOperation
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
      : [{ label: partial ? '查看失败项' : configOperation ? '查看插件' : action === 'uninstall' || action === 'cleanup' ? '返回插件详情' : '查看插件', run: () => {
      if (partial && pluginId && failedTarget) {
        if (failedIssue) leaveResult({ name: 'issueDetail', issueId: failedIssue.issueId });
        else leaveResult({ name: 'platform', pluginId, platform: failedTarget.platform });
      } else if (pluginId && snapshot.viewModel?.plugins.some((entry) => entry.pluginId === pluginId)) {
        leaveResult({ name: 'pluginDetail', pluginId });
      }
      else leaveResult({ name: 'pluginList', mode: 'installed' });
    } }, ...(partial && pluginId && failedTarget && retryAction ? [{
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
    const visibleMessages = completedResult?.summary.messages?.slice(policy.mode === 'compact' ? -2 : -4) ?? [];
    const dependencyTargets = completedResult?.summary.targets?.some((target) => target.relation) ?? false;
    const resultTargetName = (target: NonNullable<OperationResultSummary['targets']>[number]): string =>
      target.pluginId
        ? props.controller.getPluginOverview(target.pluginId)?.displayName
          ?? target.pluginId.split('/').at(-1)!
        : `${platformLabel(target.platform)} · ${scopeLabel(target.scope)}`;
    const resultStatus = blocked ? 'error' : partial ? 'warning' : 'success';
    const resultTargets = completedResult?.summary.targets ?? [];
    const resultTargetLimit = policy.mode === 'compact' ? 2 : 6;
    const prioritizedTargets = [...resultTargets].sort((left, right) => {
      const priority = (target: typeof left): number => target.state === 'failed' ? 0
        : target.state === 'skipped' ? 1 : target.relation === 'requested' ? 2 : 3;
      return priority(left) - priority(right);
    });
    const visibleResultTargets = prioritizedTargets.slice(0, resultTargetLimit);
    const hiddenResultTargets = resultTargets.length - visibleResultTargets.length;
    const portableMissingSkills = new Set(portableReceipt?.missing.map((entry) => entry.skill) ?? []);
    const prioritizedPortableSkills = [...(portableReceipt?.selectedSkills ?? [])].sort((left, right) =>
      Number(portableMissingSkills.has(right)) - Number(portableMissingSkills.has(left)));
    const portableSkillLimit = policy.mode === 'compact' ? 2 : 6;
    const visiblePortableSkills = prioritizedPortableSkills.slice(0, portableSkillLimit);
    const hiddenPortableSkills = prioritizedPortableSkills.length - visiblePortableSkills.length;
    const portableRows = visiblePortableSkills.map((skill) => {
      const missing = portableMissingSkills.has(skill);
      const status = portableReceipt?.verificationUnknown ? 'warning' as const
        : missing ? 'warning' as const : 'success' as const;
      const meta = portableReceipt?.verificationUnknown ? '结果未知'
        : missing ? '未完成 · 缺少目标' : '已安装';
      return <ResultRow key={skill} title={skill} meta={meta} status={status} compact />;
    });
    content = portableOperation ? <Box flexDirection="column">
      <ResultCard status={resultStatus} title={blocked ? '安装未开始或结果未确认' : partial ? '部分 Skills 未确认' : '通用 Skills 安装结果'}>
        {portableRows}
        {hiddenPortableSkills > 0 ? <StaticRow title={`另有 ${hiddenPortableSkills} 个 Skills`} status="muted" compact /> : null}
        {portableReceipt ? <StaticRow title={`Agent：${portableReceipt.agentMode === 'automatic' ? 'Skills CLI 默认选择' : portableReceipt.requestedAgents.join('、')}`} meta={`范围：${scopeLabel(portableReceipt.scope)}`} compact /> : null}
        {portableReceipt?.recovery ? policy.mode === 'compact'
          ? <StaticRow title="安全恢复" meta={portableReceipt.recovery} status="warning" compact />
          : <Callout status="warning" title="安全恢复" description={portableReceipt.recovery} /> : null}
        {showTechnical && portableReceipt ? <TechnicalDetails>
          <StaticRow title="Skills CLI version" meta={portableReceipt.skillsCliVersion} compact />
          <StaticRow title="materialization digest" meta={portableReceipt.materializationDigest} compact />
          {completedResult?.summary.elapsedMs !== undefined ? <StaticRow title="elapsed" meta={`${completedResult.summary.elapsedMs} ms`} compact /> : null}
          <StaticRow title="verification missing" meta={String(portableReceipt.missing.length)} compact />
          {portableReceipt.failureCode ? <StaticRow title="failure code" meta={portableReceipt.failureCode} compact /> : null}
        </TechnicalDetails> : null}
      </ResultCard>
      <SemanticRows actions={actions} focus={focus} kind="action" compact limit={policy.mode === 'compact' ? 2 : undefined} />
    </Box> : <Box flexDirection="column"><ResultCard status={resultStatus} title={blocked ? `${result.writeMayHaveCompleted ? '结果未确认' : '操作未完成'} · ${result.code}` : sourceOperation ? '来源配置写入已完成' : dependencyTargets ? partial ? '依赖安装没有全部完成' : '操作已完成' : completedResult?.summary.message ?? '状态已变化，请重新确认'}>{visibleResultTargets.map((target) => { const state = operationTargetStateLabel(target.state); const relation = target.relation === 'requested' ? '你选择的插件' : target.relation === 'direct' ? '直接依赖' : target.relation === 'transitive' ? '间接依赖' : undefined; return <ResultRow key={`${target.pluginId ?? ''}:${target.platform}:${target.scope}`} title={resultTargetName(target)} description={relation} meta={state.label} status={state.status ?? 'muted'} compact />; })}{hiddenResultTargets > 0 ? <StaticRow title={`另有 ${hiddenResultTargets} 个目标`} status="muted" compact /> : null}{partial && resultTargets.some((target) => target.state === 'skipped') ? <StaticRow title="未执行的目标没有写入；已完成或已保留的目标保持可用。" status="muted" compact /> : null}{completedResult?.summary.elapsedMs !== undefined ? <StaticRow title="已用时" meta={`${Math.floor(completedResult.summary.elapsedMs / 1_000)}s`} /> : null}{visibleMessages.map((message, index) => <StaticRow key={`${index}:${message}`} title={message} status="muted" compact />)}</ResultCard><SemanticRows actions={actions} focus={focus} kind="action" compact /></Box>;
  } else if (route.name === 'pluginAbout' && plugin) {
    breadcrumb = `${plugin.displayName} / 关于`;
    title = plugin.displayName;
    description = plugin.description;
    actions = [{ label: '查看技术详情', run: () => go({ name: 'pluginTechnical', pluginId: plugin.pluginId }) }, { label: '查看来源', run: () => go({ name: 'sourceDetail', sourceId: plugin.sourceId }) }];
    content = <Box flexDirection="column"><SectionCard><StaticRow title="版本" meta={plugin.version ?? '未知'} /><StaticRow title="来源" meta={plugin.sourceLabel} /><StaticRow title="可用工具" meta={plugin.supportedPlatforms.map(platformLabel).join('、')} /><StaticRow title="配置" meta={`${plugin.configFieldCount} 个字段`} /></SectionCard><SemanticRows actions={actions} focus={focus} kind="action" compact={policy.mode === 'compact'} /></Box>;
  } else if (route.name === 'pluginTechnical' && plugin) {
    breadcrumb = `${plugin.displayName} / 技术详情`;
    context = '只读';
    title = '安装与身份详情';
    description = '默认页面不会展示这些内部信息。';
    actions = [{ label: '返回插件', run: back }];
    content = <Box flexDirection="column"><TechnicalDetails><StaticRow title="canonical pluginId" meta={plugin.pluginId} /><StaticRow title="来源" meta={plugin.sourceId} />{plugin.installedPlacements.map((placement) => <StaticRow key={placement.platform} title={`${platformLabel(placement.platform)} target`} meta={placementStatus(placement).value} />)}{plugin.technicalComponents.map((component) => <StaticRow key={`${component.platform}:${component.scope}:${component.key}`} title={`${platformLabel(component.platform)} · ${scopeLabel(component.scope)} · ${component.key}`} meta={`${component.state}${component.errorCode ? ` · ${component.errorCode}` : ''}`} />)}</TechnicalDetails><SemanticRows actions={actions} focus={focus} kind="action" compact={policy.mode === 'compact'} /></Box>;
  } else {
    breadcrumb = '后续阶段';
    title = '此业务页将在后续阶段接入';
    description = '当前阶段只实现插件发现、安装和维护页面。';
    actions = [{ label: '返回上一页', run: back }];
    content = <SemanticRows actions={actions} focus={focus} kind="action" compact={policy.mode === 'compact'} />;
  }

  const runAction = (action: ActionItem | undefined): void => {
    try {
      const pending = action?.run?.();
      if (pending) void pending.catch(() => {
        setActionError('操作未完成。请重新检查后重试。');
      });
    } catch {
      setActionError('操作未完成。请重新检查后重试。');
    }
  };

  useInput((input, key) => {
    if (busy) {
      if (input.toLowerCase() === 'q' || (key.ctrl && input.toLowerCase() === 'c')) {
        setExitAfterBusy(true);
      } else if (!tooSmall && input.toLowerCase() === 'd') {
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
        setOverlayFocus((value) => value === 0 ? 1 : 0);
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
      if (key.backspace || key.delete) setPortableAgentInput((value) => value.slice(0, -1));
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
      if (key.backspace || key.delete) setSourceInput((value) => value.slice(0, -1));
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
      if (key.backspace || key.delete) setInputValue((value) => value.slice(0, -1));
      else if (input && !key.ctrl && !key.meta && input >= ' ') setInputValue((value) => value + input);
      setInputError(undefined);
      return;
    }
    if (searchMode && route.name === 'pluginList') {
      if (key.escape) {
        setSearchMode(false);
        return;
      }
      if (key.backspace || key.delete) setQuery((value) => value.slice(0, -1));
      else if (input && !key.ctrl && !key.meta && input >= ' ') setQuery((value) => value + input);
      setFocus(0);
      setScrollOffset(0);
      return;
    }
    if (key.tab && (route.name === 'configLayer'
      || route.name === 'configFields'
      || route.name === 'configFieldEditor'
      || route.name === 'configPresets')) {
      return;
    }
    if (input === '?') {
      setOverlayFocus(0);
      setOverlay('help');
    } else if (input.toLowerCase() === 'q') {
      setOverlayFocus(0);
      setDiscardForExit(dirty);
      setOverlay(dirty ? 'discard' : 'exit');
    } else if (input.toLowerCase() === 'd' && (route.name === 'review'
      || route.name === 'issueDetail'
      || route.name === 'configUnavailable'
      || route.name === 'pluginDependencies'
      || route.name === 'portableSkillSelect'
      || route.name === 'portableDependencies'
      || route.name === 'portableBlocker'
      || (route.name === 'result' && snapshot.result && 'operationKind' in snapshot.result
        && snapshot.result.operationKind === 'portableInstall'))) {
      setShowTechnical((value) => !value);
    } else if ((key.escape || input.toLowerCase() === 'b')
      && (route.name === 'configFieldEditor'
        || route.name === 'configPresets'
        || (route.name === 'configFields' && Boolean(route.groupId)))) {
      back();
    } else if (key.escape || input.toLowerCase() === 'b') {
      if (dirty) {
        setOverlayFocus(0);
        setDiscardForExit(false);
        setOverlay('discard');
      } else back();
    } else if (route.name === 'pluginList' && input === '/') {
      setSearchMode(true);
    } else if (route.name === 'configFields' && route.layer.scope !== 'effective' && input.toLowerCase() === 's') {
      if (dirty) void beginConfigSave();
    } else if (route.name === 'configFields' && route.layer.scope !== 'effective' && input.toLowerCase() === 'u') {
      const key = actions[focus]?.configKey;
      if (key) removeDraft(key);
    } else if (input.toLowerCase() === 'r' && route.name === 'sourceDetail') {
      void props.controller.refreshSource(route.sourceId);
    } else if (input.toLowerCase() === 'r' && route.name === 'sourceList') {
      const source = props.controller.listSources()[focus];
      if (source) void props.controller.refreshSource(source.id);
    } else if (route.name === 'pluginList' && (key.leftArrow || key.rightArrow || input === '[' || input === ']')) {
      const tabs = ['all', ...props.controller.listSources().map((source) => source.id)];
      const current = route.sourceId ?? 'all';
      const selectedPluginId = props.controller.listPlugins({
        mode: route.mode,
        ...(current !== 'all' ? { sourceId: current } : {}),
        ...(query ? { query } : {}),
      })[focus]?.pluginId;
      const direction = key.leftArrow || input === '[' ? -1 : 1;
      const index = tabs.indexOf(current);
      const next = tabs[(index + direction + tabs.length) % tabs.length]!;
      const nextItems = props.controller.listPlugins({ mode: route.mode, ...(next !== 'all' ? { sourceId: next } : {}), ...(query ? { query } : {}) });
      const retained = selectedPluginId ? nextItems.findIndex((item) => item.pluginId === selectedPluginId) : -1;
      props.controller.replace(
        { name: 'pluginList', mode: route.mode, ...(next !== 'all' ? { sourceId: next } : {}) },
        { ...snapshot.router.current.context, sourceTabId: next },
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
        const next = moveFocus(actions, value, -1);
        const viewport = route.name === 'portableSkillSelect' && snapshot.portableDraft
          ? portableSkillCandidateViewport(
              actions.slice(0, snapshot.portableDraft.candidates.length),
              snapshot.portableDraft.candidates,
              policy.mode,
              next,
              scrollOffset,
            )
          : actionViewport(route.name, actions, policy.mode, next, scrollOffset);
        setScrollOffset(viewport.offset);
        return next;
      });
    } else if (key.downArrow || input.toLowerCase() === 'j') {
      setFocus((value) => {
        const next = moveFocus(actions, value, 1);
        const viewport = route.name === 'portableSkillSelect' && snapshot.portableDraft
          ? portableSkillCandidateViewport(
              actions.slice(0, snapshot.portableDraft.candidates.length),
              snapshot.portableDraft.candidates,
              policy.mode,
              next,
              scrollOffset,
            )
          : actionViewport(route.name, actions, policy.mode, next, scrollOffset);
        setScrollOffset(viewport.offset);
        return next;
      });
    } else if (input === ' ' && route.name === 'installTools' && route.view !== 'blocked') {
      runAction(actions[focus]);
    } else if (key.return && route.name === 'installTools' && route.view !== 'blocked') {
      if (tools.length > 0) {
        setDirty(false);
        back();
      }
    } else if (key.return) {
      runAction(actions[focus]);
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
  const helpRows = [
    ['↑ / ↓', '移动当前唯一焦点'],
    ['Enter', '打开、选择或继续'],
    ['Esc / b', '返回上一页'],
    ...(route.name === 'pluginList' ? [['← / →', '切换来源'], ['/', '进入搜索']] : []),
    ...(route.name === 'installTools' ? [['Space', '切换工具选择']] : []),
    ...(route.name === 'review' || route.name === 'progress' ? [['d', '打开技术详情']] : []),
    ['?', '关闭帮助'],
  ];
  const overlayActions: ActionItem[] = overlay === 'help'
    ? [{ label: '关闭' }]
    : [
        { label: overlay === 'discard' ? '继续编辑' : '继续使用' },
        { label: overlay === 'discard' ? '放弃修改' : '退出', status: 'error' },
      ];
  return (
    <Box position="relative" width={size.columns} height={size.rows}>
      <Box>{base}</Box>
      <Box position="absolute" marginTop={5} marginLeft={Math.max(2, Math.floor(size.columns / 5))} width={Math.max(40, Math.floor(size.columns * 0.6))} flexDirection="column">
        <ReviewCard title={overlay === 'help' ? '当前页快捷键' : overlay === 'discard' ? '放弃未保存修改？' : '退出控制台？'}>
        {overlay === 'help'
          ? <>{helpRows.map(([key, value]) => <StaticRow key={key} title={key} description={value} compact />)}</>
          : <StaticRow title={overlay === 'discard' ? '放弃后将返回上一页。' : '进行中的写操作会先完成。'} status="muted" />}
        <SemanticRows actions={overlayActions} focus={overlayFocus} kind="action" compact />
        </ReviewCard>
      </Box>
    </Box>
  );
}
