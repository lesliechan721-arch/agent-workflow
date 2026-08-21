import { Box, Text, useInput, useWindowSize } from 'ink';
import { useEffect, useState } from 'react';

import type { PlatformName, Scope } from '../types.js';
import { ScreenFrame } from './components.js';
import type {
  OperationIntent,
  OperationReviewChange,
  TuiController,
  TuiControllerSnapshot,
} from './controller.js';
import { resolveTuiSizePolicy } from './layout.js';
import type {
  ConfigFieldViewModel,
  ConfigPageViewModel,
  PlatformPlacementSummary,
  PluginListItemViewModel,
} from './model.js';
import type { TuiRoute } from './router.js';
import { tuiTheme } from './theme.js';

export const CONSOLE_V4_SCREEN_IDS = [
  'G01', 'G02', 'G03', 'G04', 'G05',
  'P01', 'P02', 'P03', 'P04', 'P05', 'P06', 'P07', 'P08', 'P09', 'P10',
  'P11', 'P12', 'P13', 'P14', 'P15', 'P16', 'P17', 'P18', 'P19', 'P20', 'P21',
  'C01', 'C02', 'C03', 'C04', 'C05', 'C06', 'C07', 'C08', 'C09', 'C10',
  'C11', 'C12', 'C13', 'C14', 'C15', 'C16', 'C17',
] as const;

export type ConsoleV4ScreenId = typeof CONSOLE_V4_SCREEN_IDS[number];
type Overlay = 'help' | 'exit' | 'discard' | undefined;

interface ActionItem {
  label: string;
  description?: string;
  meta?: string;
  status?: 'success' | 'warning' | 'error' | 'muted';
  disabled?: string;
  run?: () => void | Promise<void>;
  configKey?: string;
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

function statusColor(status?: ActionItem['status']): string | undefined {
  if (status === 'success') return tuiTheme.statusColors.success;
  if (status === 'warning') return tuiTheme.statusColors.warning;
  if (status === 'error') return tuiTheme.statusColors.error;
  if (status === 'muted') return tuiTheme.colors.muted;
  return undefined;
}

function moveFocus(actions: ActionItem[], current: number, direction: -1 | 1): number {
  if (actions.length === 0) return 0;
  for (let offset = 1; offset <= actions.length; offset += 1) {
    const next = (current + direction * offset + actions.length) % actions.length;
    if (!actions[next]?.disabled) return next;
  }
  return current;
}

function ActionRows(props: {
  actions: ActionItem[];
  focus: number;
  offset?: number;
  limit?: number;
}): React.JSX.Element {
  const offset = props.offset ?? 0;
  const actions = props.limit === undefined
    ? props.actions
    : props.actions.slice(offset, offset + props.limit);
  return (
    <Box flexDirection="column">
      {actions.map((action, visibleIndex) => {
        const index = visibleIndex + offset;
        const focused = index === props.focus && !action.disabled;
        return (
          <Box
            key={`${action.label}:${index}`}
            flexDirection="column"
            paddingX={1}
            backgroundColor={focused ? tuiTheme.colors.selectionBackground : undefined}
          >
            <Box justifyContent="space-between">
              <Text
                bold={focused}
                color={action.disabled ? tuiTheme.colors.muted : statusColor(action.status)}
                wrap="truncate-end"
              >
                {focused ? '› ' : '  '}{action.label}
              </Text>
              {action.meta ? <Text color={statusColor(action.status) ?? tuiTheme.colors.muted}>{action.meta}</Text> : null}
            </Box>
            {action.description || action.disabled
              ? <Text color={tuiTheme.colors.muted} wrap="truncate-end">{'    '}{action.disabled ?? action.description}</Text>
              : null}
          </Box>
        );
      })}
    </Box>
  );
}

function Bordered(props: { title?: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={tuiTheme.colors.border} paddingX={1}>
      {props.title ? <Text bold>{props.title}</Text> : null}
      {props.children}
    </Box>
  );
}

function SourceTabs(props: {
  controller: TuiController;
  current: string;
  compact: boolean;
}): React.JSX.Element {
  const tabs = [{ id: 'all', label: '全部', count: props.controller.listPlugins({ mode: 'browse' }).length },
    ...props.controller.listSources()];
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
  if (route.name === 'pluginPreview') return 'P04';
  if (route.name === 'installPlacement') return 'P05';
  if (route.name === 'installTools') return 'P06';
  if (route.name === 'pluginDetail') return 'P13';
  if (route.name === 'platform') {
    const plugin = controller.getPluginOverview(route.pluginId);
    if (plugin?.aggregateStatus === 'unavailable') return 'P17';
    const placement = controller.getPlatformPlacement(route.pluginId, route.platform);
    if (!placement || placement.state === 'notInstalled') return 'P15';
    if (placement.state === 'installed' && placement.health === 'ready') return 'P14';
    return 'P16';
  }
  if (route.name === 'review') return snapshot.activeReview?.title === '保存插件设置'
    ? 'C12'
    : snapshot.activeReview?.title === '重置插件设置'
      ? 'C16'
      : snapshot.activeReview?.title === '升级插件'
    || snapshot.activeReview?.title === '重新安装插件'
    ? 'P18'
    : snapshot.activeReview?.title === '移除插件' || snapshot.activeReview?.title === '清理插件'
      ? 'P19' : 'P07';
  if (route.name === 'progress') return snapshot.activeReview?.title === '保存插件设置'
    || snapshot.activeReview?.title === '重置插件设置' ? 'C13' : 'P08';
  if (route.name === 'result') return snapshot.result && 'operationKind' in snapshot.result
    && snapshot.result.operationKind
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
  return 'G02';
}

export function ConsoleAppV4(props: {
  controller: TuiController;
  size?: { columns: number; rows: number };
  onExit?: () => void;
  onScreenChange?: (screen: ConsoleV4ScreenId) => void;
  ownsController?: boolean;
}): React.JSX.Element {
  const windowSize = useWindowSize();
  const size = props.size ?? windowSize;
  const policy = resolveTuiSizePolicy(size.columns, size.rows);
  const [snapshot, setSnapshot] = useState(props.controller.snapshot);
  const [overlay, setOverlay] = useState<Overlay>();
  const [overlayFocus, setOverlayFocus] = useState(0);
  const [focus, setFocus] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [searchMode, setSearchMode] = useState(false);
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<Scope>('user');
  const [tools, setTools] = useState<PlatformName[]>([]);
  const [showTechnical, setShowTechnical] = useState(false);
  const [exitAfterBusy, setExitAfterBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [configPage, setConfigPage] = useState<ConfigPageViewModel>();
  const [configLayerCounts, setConfigLayerCounts] = useState<Record<string, number>>({});
  const [configLoadKey, setConfigLoadKey] = useState(0);
  const [draftUpdates, setDraftUpdates] = useState<Record<string, string | number | boolean>>({});
  const [draftRemoves, setDraftRemoves] = useState<string[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [inputError, setInputError] = useState<string>();
  const [configActionError, setConfigActionError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [draftOwner, setDraftOwner] = useState<string>();
  const route = snapshot.router.current.route;
  const plugin = currentPlugin(props.controller, route);
  const busy = route.name === 'progress';
  const tooSmall = policy.mode === 'too-small';

  useEffect(() => {
    const unsubscribe = props.controller.subscribe(setSnapshot);
    void props.controller.load().catch(() => {
      setActionError('操作未完成。请重新检查后重试。');
    });
    return () => {
      unsubscribe();
      if (props.ownsController) props.controller.dispose();
    };
  }, [props.controller, props.ownsController]);

  useEffect(() => {
    if (exitAfterBusy && route.name === 'result') props.onExit?.();
  }, [exitAfterBusy, props.onExit, route.name]);
  useEffect(() => {
    if (route.name !== 'result'
      || !snapshot.result
      || (snapshot.result.state !== 'succeeded' && snapshot.result.state !== 'partial')
      || !snapshot.result.operationKind) return;
    setDirty(false);
    setDraftUpdates({});
    setDraftRemoves([]);
  }, [route.name, snapshot.result]);

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
    return { platform };
  });

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
    props.controller.back();
    const restored = props.controller.snapshot.router.current.context;
    setFocus(restored.focusIndex ?? 0);
    setScrollOffset(restored.scrollOffset ?? 0);
    setQuery(restored.query ?? '');
    setSearchMode(Boolean(restored.query));
    setActionError(undefined);
  };
  const beginReview = async (intent: OperationIntent): Promise<void> => {
    await props.controller.buildOperationReview(intent);
    setFocus(0);
    setScrollOffset(0);
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
    content = <Bordered><Text color={tuiTheme.statusColors.error}>× {snapshot.loadError?.code ?? 'statusLoadFailed'}</Text><Text color={tuiTheme.colors.muted}>没有执行任何写操作。</Text></Bordered>;
  } else if (snapshot.phase !== 'ready') {
    breadcrumb = '启动';
    title = '正在检查插件状态';
    description = '单个来源失败不会阻止其他来源继续加载。';
    help = 'Ctrl-C 完成后退出';
    content = (
      <Box flexDirection="column">
        <Text color={tuiTheme.statusColors.success}>✓ 读取插件来源</Text>
        <Text color={tuiTheme.colors.accent}>● 检查当前项目</Text>
        <Text color={tuiTheme.colors.muted}>○ 汇总可用操作</Text>
      </Box>
    );
  } else if (route.name === 'home') {
    const home = snapshot.viewModel!.home;
    context = '当前项目';
    content = (
      <Box flexDirection="column">
        <Text>
          <Text color={tuiTheme.statusColors.success}>✓ {home.installedPlugins} 个插件可用</Text>
          {'    '}<Text color={tuiTheme.statusColors.warning}>! {home.issueCount} 项需要处理</Text>
          {'    '}<Text color={tuiTheme.statusColors.warning}>◐ {home.unavailableSourceCount} 个来源不可用</Text>
        </Text>
        <Box marginTop={1}><ActionRows actions={actions} focus={focus} /></Box>
      </Box>
    );
    actions = [
      { label: '添加插件', description: '浏览多个来源中的 Agent 能力', meta: String(home.availablePlugins), run: () => go({ name: 'pluginList', mode: 'browse' }) },
      { label: '我的插件', description: '查看状态、设置和移除已添加插件', meta: String(home.installedPlugins), run: () => go({ name: 'pluginList', mode: 'installed' }) },
      { label: '需要处理', description: '解决安装、来源或设置问题', meta: String(home.issueCount), status: 'warning', run: () => go({ name: 'issueList' }) },
      { label: '插件来源', description: '管理 Git 仓库和本地目录', meta: String(home.sourceCount), run: () => go({ name: 'sourceList' }) },
    ];
    content = (
      <Box flexDirection="column">
        <Text>
          <Text color={tuiTheme.statusColors.success}>✓ {home.installedPlugins} 个插件可用</Text>
          {'    '}<Text color={tuiTheme.statusColors.warning}>! {home.issueCount} 项需要处理</Text>
          {'    '}<Text color={tuiTheme.statusColors.warning}>◐ {home.unavailableSourceCount} 个来源不可用</Text>
        </Text>
        <Box marginTop={1}><ActionRows actions={actions} focus={focus} /></Box>
      </Box>
    );
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
    content = (
      <Box flexDirection="column">
        <SourceTabs controller={props.controller} current={sourceId} compact={policy.mode === 'compact'} />
        <Text color={searchMode ? tuiTheme.colors.accent : tuiTheme.colors.muted}>/ {searchMode ? query || '输入搜索内容' : '搜索名称、用途或来源…'}</Text>
        {sourceError
          ? <Bordered><Text bold>{sourceId} 暂时无法提供插件</Text><Text color={tuiTheme.colors.muted}>没有可用缓存，因此当前不能浏览这个来源。</Text></Bordered>
          : route.mode === 'installed' && items.length === 0
            ? <Bordered><Text bold>开始添加第一个插件</Text><Text color={tuiTheme.colors.muted}>插件可以安装到 Codex、Claude Code 或两者。</Text></Bordered>
            : null}
        <ActionRows
          actions={actions}
          focus={focus}
          offset={policy.mode === 'compact' ? scrollOffset : undefined}
          limit={policy.mode === 'compact' ? 4 : undefined}
        />
      </Box>
    );
  } else if (route.name === 'pluginPreview' && plugin) {
    breadcrumb = `添加插件 / ${plugin.displayName}`;
    context = plugin.sourceLabel;
    title = `${plugin.displayName}${plugin.version ? `  ${plugin.version}` : ''}`;
    description = plugin.description;
    actions = [
      { label: '添加插件', description: '选择使用位置并确认变化', run: () => {
        const initialScope = (['user', 'project'] as const).find((candidateScope) =>
          selectedPlatforms(plugin, candidateScope).some((entry) => !entry.disabled)) ?? scope;
        const available = selectedPlatforms(plugin, initialScope).filter((entry) => !entry.disabled).map((entry) => entry.platform);
        setScope(initialScope);
        setTools(available);
        go({ name: 'installPlacement', pluginId: plugin.pluginId });
      } },
      { label: '查看插件设置定义', description: `${plugin.configFieldCount} 个配置字段`, run: () => go({ name: 'configLayer', pluginId: plugin.pluginId }) },
      { label: '查看来源', run: () => go({ name: 'sourceDetail', sourceId: plugin.sourceId }) },
    ];
    content = <Box flexDirection="column"><Bordered title="可用工具"><Text>{plugin.supportedPlatforms.map(platformLabel).join(' · ') || '暂无可用工具'}</Text></Bordered><Bordered title="使用说明"><Text>✓ 在 Agent 会话中提供能力</Text><Text color={tuiTheme.colors.muted}>安装不会自动修改项目源码。</Text></Bordered><ActionRows actions={actions} focus={focus} /></Box>;
  } else if (route.name === 'installPlacement' && plugin) {
    breadcrumb = `${plugin.displayName} / 添加`;
    context = '第 1 步，共 2 步';
    title = `你希望在哪里使用 ${plugin.displayName}？`;
    description = '工具已根据插件能力自动选择；需要时可以调整。';
    const availableScopes = (['user', 'project'] as const).filter((candidateScope) =>
      selectedPlatforms(plugin, candidateScope).some((entry) => !entry.disabled));
    actions = [
      ...availableScopes.map((candidateScope) => ({
        label: `${candidateScope === scope ? '●' : '○'} ${scopeLabel(candidateScope)}`,
        description: candidateScope === 'user' ? '在任意项目中可使用，适合个人常用能力' : '仅在当前项目中使用，适合团队共享',
        meta: candidateScope === 'user' ? '推荐' : undefined,
        run: () => {
          setScope(candidateScope);
          setTools(selectedPlatforms(plugin, candidateScope).filter((entry) => !entry.disabled).map((entry) => entry.platform));
        },
      })),
      { label: '继续', disabled: tools.length === 0 ? '没有可安装的工具' : undefined, run: async () => beginReview(installIntent(plugin)) },
      { label: '调整工具…', run: () => go({ name: 'installTools', pluginId: plugin.pluginId }) },
    ];
    content = <Box flexDirection="column"><ActionRows actions={actions.slice(0, availableScopes.length)} focus={focus} /><Bordered title="可用工具"><Text>{tools.map(platformLabel).join('、')}（已自动选择）</Text></Bordered><ActionRows actions={actions.slice(availableScopes.length)} focus={focus - availableScopes.length} /></Box>;
  } else if (route.name === 'installTools' && plugin) {
    breadcrumb = `${plugin.displayName} / 添加 / 工具`;
    context = '可选';
    title = '选择要添加到哪些工具';
    description = '同一插件、同一平台只能安装到一个位置。';
    const choices = selectedPlatforms(plugin, scope);
    actions = choices.map((choice) => ({
        label: `${tools.includes(choice.platform) ? '◆' : '◇'} ${platformLabel(choice.platform)}`,
        description: choice.disabled ?? '当前未安装，支持所选位置',
        meta: tools.includes(choice.platform) ? '已选择' : undefined,
        disabled: choice.disabled,
        run: () => {
          setDirty(true);
          setTools((current) => current.includes(choice.platform)
            ? current.filter((platform) => platform !== choice.platform)
            : [...current, choice.platform]);
        },
      })),
    help = '↑↓ 移动 · Space 切换 · Enter 完成 · Esc 返回';
    content = <Box flexDirection="column"><ActionRows actions={actions} focus={focus} /><Text color={tools.length > 0 ? tuiTheme.colors.accent : tuiTheme.statusColors.warning}>Enter {tools.length > 0 ? '完成选择' : '至少选择一个工具'}</Text></Box>;
  } else if (route.name === 'pluginDetail' && plugin) {
    breadcrumb = `我的插件 / ${plugin.displayName}`;
    context = `${plugin.sourceLabel}${plugin.version ? ` · ${plugin.version}` : ''}`;
    title = plugin.displayName;
    description = plugin.description;
    actions = [
      ...plugin.installedPlacements.map((placement) => {
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
      }),
      { label: '设置', description: '个人默认、当前项目和本机覆盖', meta: `${plugin.configFieldCount} 项配置`, run: () => go({ name: 'configLayer', pluginId: plugin.pluginId }) },
      { label: '关于与技术详情', description: '版本、来源和受管内容', run: () => go({ name: 'pluginAbout', pluginId: plugin.pluginId }) },
    ];
    content = <Box flexDirection="column"><Bordered title="使用状态"><ActionRows actions={actions.slice(0, plugin.installedPlacements.length)} focus={focus} /></Bordered><Bordered title="插件设置"><ActionRows actions={actions.slice(plugin.installedPlacements.length, -1)} focus={focus - plugin.installedPlacements.length} /></Bordered><ActionRows actions={actions.slice(-1)} focus={focus - actions.length + 1} /></Box>;
  } else if (route.name === 'platform' && plugin) {
    const placement = props.controller.getPlatformPlacement(plugin.pluginId, route.platform);
    breadcrumb = `${plugin.displayName} / ${platformLabel(route.platform)}`;
    if (plugin.aggregateStatus === 'unavailable') {
      title = `暂时无法管理 ${platformLabel(route.platform)}`;
      description = '插件来源不可用，当前状态不能安全确认。';
      actions = [{ label: '查看来源问题', description: `${plugin.sourceId} 无可用缓存`, run: () => go({ name: 'issueDetail', issueId: `source:${plugin.sourceId}:unavailable` }) }, { label: '重新检查状态', description: '不会修改现场内容', run: () => props.controller.refreshSource(plugin.sourceId) }];
      content = <Box flexDirection="column"><Bordered><Text color={tuiTheme.statusColors.error}>× 来源不可用</Text><Text color={tuiTheme.colors.muted}>插件设置保持不变</Text></Bordered><ActionRows actions={actions} focus={focus} /></Box>;
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
      content = <Box flexDirection="column"><Bordered><Text color={tuiTheme.colors.muted}>○ 未添加</Text><Text color={tuiTheme.colors.muted}>插件设置保持不变</Text></Bordered><ActionRows actions={actions} focus={focus} /></Box>;
    } else if (placement.state === 'scopeConflict') {
      title = '安装位置冲突';
      description = '正常状态只能保留一个位置。';
      actions = [{ label: '查看位置冲突问题', run: () => go({ name: 'issueDetail', issueId: `scope:${plugin.pluginId}:${route.platform}` }) }];
      content = <ActionRows actions={actions} focus={focus} />;
    } else if (placement.health !== 'ready') {
      title = `${platformLabel(route.platform)} ${placement.health === 'incomplete' ? '安装不完整' : '暂时不可用'}`;
      description = '缺少一项必要内容，插件可能无法稳定启动。';
      actions = [
        { label: '重新连接缺失内容…', description: '保留现有设置', run: () => beginReview({ kind: 'pluginWrite', action: 'reinstall', pluginId: plugin.pluginId, platform: route.platform, scope: placement.scope }) },
        { label: '查看影响', description: '缺少的内容和范围', run: () => go({ name: 'pluginTechnical', pluginId: plugin.pluginId }) },
        { label: `从${scopeLabel(placement.scope)}移除…`, description: '保留插件设置', status: 'error', run: () => beginReview({ kind: 'pluginWrite', action: 'uninstall', pluginId: plugin.pluginId, platform: route.platform, scope: placement.scope }) },
      ];
      content = <Box flexDirection="column"><Bordered><Text color={tuiTheme.statusColors.warning}>! 需要处理</Text><Text color={tuiTheme.colors.muted}>{scopeLabel(placement.scope)} · {plugin.sourceLabel}</Text></Bordered><ActionRows actions={actions} focus={focus} /></Box>;
    } else {
      title = `已安装到${scopeLabel(placement.scope)}`;
      description = `当前检查正常${plugin.version ? `；版本 ${plugin.version}` : ''}。`;
      actions = [
        { label: '运行升级…', description: '使用当前来源中的版本重建', run: () => beginReview({ kind: 'pluginWrite', action: 'upgrade', pluginId: plugin.pluginId, platform: route.platform, scope: placement.scope }) },
        { label: '重新安装…', description: '重新生成并验证受管内容', run: () => beginReview({ kind: 'pluginWrite', action: 'reinstall', pluginId: plugin.pluginId, platform: route.platform, scope: placement.scope }) },
        { label: `从${scopeLabel(placement.scope)}移除…`, description: '保留插件设置', status: 'error', run: () => beginReview({ kind: 'pluginWrite', action: 'uninstall', pluginId: plugin.pluginId, platform: route.platform, scope: placement.scope }) },
        { label: '查看安装详情', description: '组件与诊断信息', run: () => go({ name: 'pluginTechnical', pluginId: plugin.pluginId }) },
      ];
      content = <Box flexDirection="column"><Bordered><Text color={tuiTheme.statusColors.success}>✓ 状态正常</Text><Text color={tuiTheme.colors.muted}>{scopeLabel(placement.scope)}{plugin.version ? ` · 当前版本 ${plugin.version}` : ''}</Text></Bordered><ActionRows actions={actions} focus={focus} /></Box>;
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
    content = <ActionRows actions={actions} focus={focus} />;
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
      content = <Text color={tuiTheme.colors.accent}>● 正在读取可信设置定义</Text>;
    } else if (readonly) {
      actions = selectedGroups.flatMap((group) => group.fields.map((field) => ({
        label: field.title,
        description: `来自${field.sourceLabel}`,
        meta: currentFieldDisplay(field),
      })));
      const limit = policy.mode === 'compact' ? 4 : 7;
      content = <Bordered title="有效设置"><ActionRows actions={actions} focus={focus} offset={scrollOffset} limit={limit} /></Bordered>;
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
        ? <Bordered title="设置字段"><ActionRows actions={actions} focus={focus} offset={scrollOffset} limit={policy.mode === 'compact' ? 4 : 7} /></Bordered>
        : <Box flexDirection="column">{rowGroups.map((group) => {
        const offset = rowOffset;
        rowOffset += group.rows.length;
        return <Bordered key={group.id} title={group.title}><ActionRows actions={actions} focus={focus} offset={offset} limit={group.rows.length} /></Bordered>;
      })}{!route.groupId ? <ActionRows actions={actions} focus={focus} offset={rowOffset} /> : null}</Box>;
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
        meta: draftUpdates[activeField.key] === value || (!Object.hasOwn(draftUpdates, activeField.key) && activeField.value === value) ? '●' : '○',
        run: () => { updateDraft(activeField.key, value); back(); },
      }));
      content = <ActionRows actions={actions} focus={focus} />;
    } else if (route.editor === 'boolean') {
      title = `${activeField.title}？`;
      description = activeField.description ?? '选择开启或关闭。';
      actions = [{ label: '开启', run: () => { updateDraft(activeField.key, true); back(); } }, { label: '关闭', run: () => { updateDraft(activeField.key, false); back(); } }];
      content = <ActionRows actions={actions} focus={focus} />;
    } else {
      title = route.editor === 'number' ? `输入${activeField.title}` : route.editor === 'path' ? `选择${activeField.title}` : route.editor === 'sensitive' ? '输入敏感值' : `输入${activeField.title}`;
      description = route.editor === 'number'
        ? `允许范围：${activeField.min ?? '不限'}–${activeField.max ?? '不限'}${activeField.unit ? ` ${activeField.unit}` : ''}。`
        : route.editor === 'path' ? `${activeField.type === 'file' ? '文件' : '目录'}路径会在保存前由现有 schema 路径验证。`
          : route.editor === 'sensitive' ? '当前值不会回显；留空不会自动删除旧值。' : activeField.description ?? '';
      const visibleInput = route.editor === 'sensitive' ? '•'.repeat(inputValue.length) : inputValue;
      content = <Bordered><Text>{visibleInput || activeField.placeholder || ' '}</Text><Text color={inputError ? tuiTheme.statusColors.error : tuiTheme.colors.muted}>{inputError ?? (route.editor === 'sensitive' ? '输入已隐藏。' : route.editor === 'path' ? '绝对路径只在此输入页短暂显示。' : activeField.placeholder ?? '按 Enter 使用输入值。')}</Text></Bordered>;
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
    content = currentConfigPage ? <ActionRows actions={actions} focus={focus} /> : <Text color={tuiTheme.colors.accent}>● 正在读取预设</Text>;
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
      { label: '返回', run: back },
    ];
    content = <Box flexDirection="column"><Bordered><Text color={tuiTheme.statusColors.error}>× Manifest 或来源不可用</Text><Text color={tuiTheme.colors.muted}>已保存的设置不会丢失。无法证明设置身份，因此重置已禁用。</Text></Bordered><ActionRows actions={actions} focus={focus} /></Box>;
  } else if (route.name === 'review' && snapshot.activeReview) {
    const review = snapshot.activeReview;
    breadcrumb = `${review.subject.name} / ${review.title}`;
    title = `${snapshot.result?.state === 'stale' ? '状态已变化 · ' : ''}确认${review.title} ${review.subject.name}`;
    description = snapshot.result?.state === 'stale' ? '当前状态已变化。请检查新的变化后再次确认。' : review.description;
    actions = [
      ...review.changes.map((change) => ({
        label: `${reviewSymbol(change)} ${change.title}`,
        description: change.description,
        status: change.kind === 'remove' ? 'error' as const
          : change.kind === 'warning' ? 'warning' as const
            : change.kind === 'keep' || change.kind === 'add' ? 'success' as const : undefined,
      })),
      { label: review.primaryLabel, description: '执行前将再次检查当前状态', status: review.destructive ? 'error' : undefined, run: () => props.controller.executeOperation(review.reviewToken).then(() => {
        setFocus(0);
        setScrollOffset(0);
      }) },
      { label: '返回修改', run: back },
    ];
    const reviewLimit = policy.mode === 'compact' ? 4 : 7;
    content = <Box flexDirection="column"><Bordered><Text bold>{review.subject.name}  {review.subject.sourceLabel} {review.subject.version}</Text><ActionRows actions={actions} focus={focus} offset={scrollOffset} limit={reviewLimit} /><Text color={tuiTheme.colors.muted}>▸ 技术详情（d）</Text>{showTechnical ? review.technicalDetails?.map((detail) => <Text key={detail} color={tuiTheme.colors.muted}>{detail}</Text>) : null}</Bordered></Box>;
  } else if (route.name === 'progress') {
    const configOperation = snapshot.activeReview?.title === '保存插件设置'
      || snapshot.activeReview?.title === '重置插件设置';
    breadcrumb = configOperation ? '设置 / 进度' : '插件操作 / 进度';
    title = configOperation ? '正在保存并应用设置' : '正在执行插件操作';
    description = configOperation ? '先保存所选层，再重新应用当前可见安装位置。' : '请勿关闭当前终端。';
    help = 'd 技术进度 · Ctrl-C 完成后退出';
    const progress = snapshot.progress;
    content = <Box flexDirection="column"><Text color={tuiTheme.statusColors.success}>✓ {configOperation ? '验证设置值' : '检查兼容性'}</Text><Text color={tuiTheme.colors.accent}>● {progress.current?.phase ?? (configOperation ? '保存设置层并重新应用' : '连接到所选工具')}</Text><Text color={tuiTheme.colors.muted}>○ 验证结果</Text>{progress.current ? <Text color={tuiTheme.colors.muted}>当前：{progress.current.target}</Text> : null}{showTechnical ? progress.messages.slice(-8).map((message) => <Text key={message} color={tuiTheme.colors.muted}>{message}</Text>) : null}{exitAfterBusy ? <Text color={tuiTheme.statusColors.warning}>操作完成后退出。</Text> : null}</Box>;
  } else if (route.name === 'result' && snapshot.result) {
    const result = snapshot.result;
    const partial = result.state === 'partial';
    const blocked = result.state === 'blocked';
    breadcrumb = '插件操作 / 结果';
    const action = result.state === 'succeeded' || result.state === 'partial'
      ? result.summary.action
      : undefined;
    const configOperation = 'operationKind' in result ? result.operationKind : undefined;
    const completedTitle = {
      install: '✓ 插件添加完成',
      upgrade: '✓ 插件升级完成',
      reinstall: '✓ 插件重新安装完成',
      uninstall: '✓ 插件移除完成',
      cleanup: '✓ 插件清理完成',
    }[action ?? 'install'];
    title = configOperation
      ? blocked
        ? '× 设置未确认保存'
        : partial ? '! 设置已保存，但部分应用失败' : '✓ 设置已保存并应用'
      : partial ? '! 插件操作只完成了一部分' : blocked ? '× 插件操作未完成' : completedTitle;
    description = blocked ? result.message : configOperation ? '设置层已经更新。' : '状态已刷新。';
    const completedResult = result.state === 'succeeded' || result.state === 'partial'
      ? result
      : undefined;
    const pluginId = completedResult?.summary.pluginId
      ?? ('pluginId' in result ? result.pluginId : undefined);
    const failedTarget = completedResult?.summary.targets?.find((target) => target.state === 'failed');
    actions = [{ label: partial ? '查看失败项' : configOperation ? '查看插件' : action === 'uninstall' || action === 'cleanup' ? '返回插件详情' : '查看插件', run: () => {
      if (partial && pluginId && failedTarget) {
        go({ name: 'issueDetail', issueId: `target:${pluginId}:${failedTarget.platform}:${failedTarget.scope}:error` });
      } else if (pluginId && snapshot.viewModel?.plugins.some((entry) => entry.pluginId === pluginId)) {
        go({ name: 'pluginDetail', pluginId });
      }
      else go({ name: 'pluginList', mode: 'installed' });
    } }, ...(partial && pluginId && failedTarget && (action || configOperation) ? [{
      label: '重试失败部分…',
      run: () => beginReview({
        kind: 'pluginWrite',
        action: action ?? 'reinstall',
        pluginId,
        platform: failedTarget.platform,
        scope: failedTarget.scope,
      }),
    }] : []), { label: '返回首页', run: () => go({ name: 'home' }) }];
    content = <Box flexDirection="column"><Bordered>{result.state === 'blocked' ? <Text color={tuiTheme.statusColors.error}>操作未完成 · {result.code}</Text> : completedResult ? (completedResult.summary.targets ?? []).map((target) => <Box key={`${target.platform}:${target.scope}`} justifyContent="space-between"><Text>{platformLabel(target.platform)} · {scopeLabel(target.scope)}</Text><Text color={target.state === 'completed' ? tuiTheme.statusColors.success : tuiTheme.statusColors.error}>{target.state === 'completed' ? '已完成' : '失败'}</Text></Box>) : <Text color={tuiTheme.statusColors.warning}>状态已变化，请重新确认。</Text>}</Bordered><ActionRows actions={actions} focus={focus} /></Box>;
  } else if (route.name === 'pluginAbout' && plugin) {
    breadcrumb = `${plugin.displayName} / 关于`;
    title = plugin.displayName;
    description = plugin.description;
    actions = [{ label: '查看技术详情', run: () => go({ name: 'pluginTechnical', pluginId: plugin.pluginId }) }, { label: '查看来源', run: () => go({ name: 'sourceDetail', sourceId: plugin.sourceId }) }];
    content = <Box flexDirection="column"><Bordered><Text color={tuiTheme.colors.muted}>版本      <Text color={tuiTheme.colors.text}>{plugin.version ?? '未知'}</Text></Text><Text color={tuiTheme.colors.muted}>来源      <Text color={tuiTheme.colors.text}>{plugin.sourceLabel}</Text></Text><Text color={tuiTheme.colors.muted}>可用工具  <Text color={tuiTheme.colors.text}>{plugin.supportedPlatforms.map(platformLabel).join('、')}</Text></Text><Text color={tuiTheme.colors.muted}>配置      <Text color={tuiTheme.colors.text}>{plugin.configFieldCount} 个字段</Text></Text></Bordered><ActionRows actions={actions} focus={focus} /></Box>;
  } else if (route.name === 'pluginTechnical' && plugin) {
    breadcrumb = `${plugin.displayName} / 技术详情`;
    context = '只读';
    title = '安装与身份详情';
    description = '默认页面不会展示这些内部信息。';
    actions = [{ label: '返回插件', run: back }];
    content = <Box flexDirection="column"><Bordered><Text color={tuiTheme.colors.muted}>canonical pluginId  <Text color={tuiTheme.colors.text}>{plugin.pluginId}</Text></Text><Text color={tuiTheme.colors.muted}>来源                <Text color={tuiTheme.colors.text}>{plugin.sourceId}</Text></Text>{plugin.installedPlacements.map((placement) => <Text key={placement.platform} color={tuiTheme.colors.muted}>{platformLabel(placement.platform)} target         <Text color={tuiTheme.colors.text}>{placementStatus(placement).value}</Text></Text>)}</Bordered><ActionRows actions={actions} focus={focus} /></Box>;
  } else {
    breadcrumb = '后续阶段';
    title = '此业务页将在后续阶段接入';
    description = '当前阶段只实现插件发现、安装和维护页面。';
    actions = [{ label: '返回上一页', run: back }];
    content = <ActionRows actions={actions} focus={focus} />;
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
    if (tooSmall) {
      if (input.toLowerCase() === 'q' || (key.ctrl && input.toLowerCase() === 'c')) props.onExit?.();
      return;
    }
    if (overlay) {
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
          back();
        } else props.onExit?.();
      }
      return;
    }
    if (busy) {
      if (input.toLowerCase() === 'd') setShowTechnical((value) => !value);
      if (key.ctrl && input.toLowerCase() === 'c') setExitAfterBusy(true);
      return;
    }
    if (key.ctrl && input.toLowerCase() === 'c') {
      props.onExit?.();
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
      setOverlay(dirty ? 'discard' : 'exit');
    } else if (input.toLowerCase() === 'd' && route.name === 'review') {
      setShowTechnical((value) => !value);
    } else if ((key.escape || input.toLowerCase() === 'b')
      && (route.name === 'configFieldEditor'
        || route.name === 'configPresets'
        || (route.name === 'configFields' && Boolean(route.groupId)))) {
      back();
    } else if (key.escape || input.toLowerCase() === 'b') {
      if (dirty) {
        setOverlayFocus(0);
        setOverlay('discard');
      } else back();
    } else if (route.name === 'pluginList' && input === '/') {
      setSearchMode(true);
    } else if (route.name === 'configFields' && route.layer.scope !== 'effective' && input.toLowerCase() === 's') {
      if (dirty) void beginConfigSave();
    } else if (route.name === 'configFields' && route.layer.scope !== 'effective' && input.toLowerCase() === 'u') {
      const key = actions[focus]?.configKey;
      if (key) removeDraft(key);
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
    } else if (key.upArrow || input.toLowerCase() === 'k') {
      setFocus((value) => {
        const next = moveFocus(actions, value, -1);
        const visible = policy.mode === 'compact' ? 4
          : route.name === 'configFields' || route.name === 'review' ? 7 : undefined;
        if (visible !== undefined && next < scrollOffset) setScrollOffset(next);
        else if (visible !== undefined && next >= scrollOffset + visible) setScrollOffset(next - visible + 1);
        return next;
      });
    } else if (key.downArrow || input.toLowerCase() === 'j') {
      setFocus((value) => {
        const next = moveFocus(actions, value, 1);
        const visible = policy.mode === 'compact' ? 4
          : route.name === 'configFields' || route.name === 'review' ? 7 : undefined;
        if (visible !== undefined && next < scrollOffset) setScrollOffset(next);
        else if (visible !== undefined && next >= scrollOffset + visible) setScrollOffset(next - visible + 1);
        return next;
      });
    } else if (input === ' ' && route.name === 'installTools') {
      runAction(actions[focus]);
    } else if (key.return && route.name === 'installTools') {
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
        <Bordered><Text bold>↔ 请将终端调整到至少 60 × 18</Text><Text color={tuiTheme.colors.muted}>调整后会返回原页面，不会丢失当前选择。</Text></Bordered>
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
  return (
    <Box position="relative" width={size.columns} height={size.rows}>
      <Box>{base}</Box>
      <Box position="absolute" marginTop={5} marginLeft={Math.max(2, Math.floor(size.columns / 5))} width={Math.max(40, Math.floor(size.columns * 0.6))} flexDirection="column" borderStyle="round" borderColor={tuiTheme.colors.accent} paddingX={1}>
        <Text bold>{overlay === 'help' ? '当前页快捷键' : overlay === 'discard' ? '放弃未保存修改？' : '退出控制台？'}</Text>
        {overlay === 'help'
          ? <>{helpRows.map(([key, value]) => <Text key={key}>{key.padEnd(9)}{value}</Text>)}</>
          : <Text color={tuiTheme.colors.muted}>{overlay === 'discard' ? '放弃后将返回上一页。' : '进行中的写操作会先完成。'}</Text>}
        <Text bold color={overlayFocus === 0 ? tuiTheme.colors.accent : undefined}>› {overlay === 'help' ? '关闭' : overlay === 'discard' ? '继续编辑' : '继续使用'}</Text>
        {overlay === 'exit' || overlay === 'discard' ? <Text bold color={overlayFocus === 1 ? tuiTheme.statusColors.error : undefined}>{overlayFocus === 1 ? '› ' : '  '}{overlay === 'discard' ? '放弃修改' : '退出'}</Text> : null}
      </Box>
    </Box>
  );
}
