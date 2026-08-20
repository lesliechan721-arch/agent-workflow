import { PasswordInput, TextInput } from '@inkjs/ui';
import { Box, Text, useInput, useWindowSize } from 'ink';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';

import type {
  DashboardAction,
  DashboardConfigData,
  DashboardConfigLocation,
  DashboardController,
  DashboardWriteAction,
} from '../commands/console.js';
import {
  dashboardActions,
  stateLabel,
  targetIdentity,
} from '../commands/console.js';
import type {
  ConsoleItemsLoadResult,
  LiveConsoleItem,
  LiveStatusState,
  LiveStatusTarget,
} from '../commands/status.js';
import type { ReceiptTargetResult } from '../types.js';
import {
  type RebuildProgressSnapshot,
} from '../output/rebuild-progress.js';
import { resolveTuiSizePolicy } from './layout.js';
import { tuiTheme } from './theme.js';

export interface DashboardResult {
  exitCode: number;
}

type FocusRegion = 'plugins' | 'targets' | 'actions';
type SinglePage = FocusRegion;

export interface DashboardState {
  loaded?: ConsoleItemsLoadResult;
  loading: boolean;
  loadError?: string;
  selectedPluginName?: string;
  selectedTargetId?: string;
  pluginIndex: number;
  targetIndex: number;
  actionIndex: number;
  focus: FocusRegion;
  singlePage: SinglePage;
  busy?: { action: string; target: string; startedAt: number; exitAfter: boolean };
  confirm?: DashboardWriteAction;
  notice?: string;
  page: 'dashboard' | 'config';
}

export type DashboardStateAction =
  | { type: 'load-start' }
  | { type: 'load-success'; loaded: ConsoleItemsLoadResult }
  | { type: 'load-error'; message: string }
  | { type: 'move'; region: FocusRegion; delta: -1 | 1 }
  | { type: 'focus'; region: FocusRegion }
  | { type: 'single-page'; page: SinglePage }
  | { type: 'confirm'; action?: DashboardWriteAction }
  | { type: 'busy-start'; action: string; target: string; startedAt: number }
  | { type: 'busy-exit-after' }
  | { type: 'busy-end'; notice: string }
  | { type: 'notice'; notice?: string }
  | { type: 'page'; page: 'dashboard' | 'config' };

function clampIndex(index: number, count: number): number {
  return count === 0 ? 0 : (index + count) % count;
}

interface Viewport {
  indexes: number[];
  hiddenAbove: number;
  hiddenBelow: number;
}

function viewport(count: number, selected: number, capacity: number): Viewport {
  if (count === 0 || capacity <= 0) return { indexes: [], hiddenAbove: 0, hiddenBelow: count };
  if (count <= capacity) {
    return { indexes: Array.from({ length: count }, (_, index) => index), hiddenAbove: 0, hiddenBelow: 0 };
  }
  if (capacity < 3) {
    const index = Math.min(Math.max(selected, 0), count - 1);
    return { indexes: [index], hiddenAbove: 0, hiddenBelow: 0 };
  }
  const visibleCount = capacity - 2;
  const selectedIndex = Math.min(Math.max(selected, 0), count - 1);
  const start = Math.min(
    Math.max(selectedIndex - Math.floor(visibleCount / 2), 0),
    count - visibleCount,
  );
  return {
    indexes: Array.from({ length: visibleCount }, (_, index) => start + index),
    hiddenAbove: start,
    hiddenBelow: count - start - visibleCount,
  };
}

function messageViewport(count: number, offset: number, capacity: number): Viewport {
  if (count === 0 || capacity <= 0) return { indexes: [], hiddenAbove: 0, hiddenBelow: count };
  const visibleCount = Math.min(count, capacity);
  const start = Math.min(Math.max(offset, 0), Math.max(0, count - visibleCount));
  return {
    indexes: Array.from({ length: visibleCount }, (_, index) => start + index),
    hiddenAbove: start,
    hiddenBelow: count - start - visibleCount,
  };
}

function scrollOffset(offset: number, count: number, capacity: number, delta: -1 | 1): number {
  const pageSize = Math.max(1, capacity - 2);
  return Math.min(Math.max(offset + delta * pageSize, 0), Math.max(0, count - 1));
}

function ViewportHint(props: { direction: 'up' | 'down'; count: number }): React.JSX.Element | null {
  if (props.count === 0) return null;
  return <Text color={tuiTheme.colors.muted}>{props.direction === 'up' ? '↑' : '↓'} 还有 {props.count} 项</Text>;
}

function selectedItem(state: DashboardState): LiveConsoleItem | undefined {
  return state.loaded?.items[state.pluginIndex];
}

function selectedTarget(state: DashboardState): LiveStatusTarget | undefined {
  return selectedItem(state)?.targets[state.targetIndex];
}

function selectedActions(state: DashboardState): DashboardAction[] {
  const item = selectedItem(state);
  const target = selectedTarget(state);
  return item && target ? dashboardActions(item, target) : [];
}

export function createInitialDashboardState(): DashboardState {
  return {
    loading: true,
    pluginIndex: 0,
    targetIndex: 0,
    actionIndex: 0,
    focus: 'plugins',
    singlePage: 'plugins',
    page: 'dashboard',
  };
}

export function dashboardReducer(
  state: DashboardState,
  action: DashboardStateAction,
): DashboardState {
  switch (action.type) {
    case 'load-start': return { ...state, loading: true, loadError: undefined };
    case 'load-error': return {
      ...state,
      loading: false,
      loadError: action.message,
      notice: `刷新失败：${action.message}`,
    };
    case 'load-success': {
      const preferredPlugin = state.selectedPluginName
        ?? state.loaded?.items[state.pluginIndex]?.pluginName;
      let pluginIndex = action.loaded.items.findIndex((item) => item.pluginName === preferredPlugin);
      if (pluginIndex < 0) pluginIndex = 0;
      const item = action.loaded.items[pluginIndex];
      const currentTarget = selectedTarget(state);
      const preferredTarget = state.selectedTargetId
        ?? (currentTarget ? targetIdentity(currentTarget) : undefined);
      let targetIndex = item?.targets.findIndex((target) => targetIdentity(target) === preferredTarget) ?? -1;
      if (targetIndex < 0) targetIndex = 0;
      const target = item?.targets[targetIndex];
      const actions = item && target ? dashboardActions(item, target) : [];
      return {
        ...state,
        loaded: action.loaded,
        loading: false,
        loadError: undefined,
        pluginIndex,
        targetIndex,
        actionIndex: Math.min(state.actionIndex, Math.max(0, actions.length - 1)),
        selectedPluginName: item?.pluginName,
        selectedTargetId: target ? targetIdentity(target) : undefined,
      };
    }
    case 'move': {
      if (action.region === 'plugins') {
        const pluginIndex = clampIndex(state.pluginIndex + action.delta, state.loaded?.items.length ?? 0);
        const item = state.loaded?.items[pluginIndex];
        const target = item?.targets[0];
        return {
          ...state,
          pluginIndex,
          targetIndex: 0,
          actionIndex: 0,
          selectedPluginName: item?.pluginName,
          selectedTargetId: target ? targetIdentity(target) : undefined,
        };
      }
      if (action.region === 'targets') {
        const item = selectedItem(state);
        const targetIndex = clampIndex(state.targetIndex + action.delta, item?.targets.length ?? 0);
        const target = item?.targets[targetIndex];
        return {
          ...state,
          targetIndex,
          actionIndex: 0,
          selectedTargetId: target ? targetIdentity(target) : undefined,
        };
      }
      return {
        ...state,
        actionIndex: clampIndex(state.actionIndex + action.delta, selectedActions(state).length),
      };
    }
    case 'focus': return { ...state, focus: action.region };
    case 'single-page': return { ...state, singlePage: action.page, focus: action.page };
    case 'confirm': return { ...state, confirm: action.action };
    case 'busy-start': return {
      ...state,
      confirm: undefined,
      busy: { action: action.action, target: action.target, startedAt: action.startedAt, exitAfter: false },
      notice: undefined,
    };
    case 'busy-exit-after': return state.busy
      ? { ...state, busy: { ...state.busy, exitAfter: true } }
      : state;
    case 'busy-end': return { ...state, busy: undefined, notice: action.notice };
    case 'notice': return { ...state, notice: action.notice };
    case 'page': return { ...state, page: action.page };
  }
}

const actionLabels: Record<DashboardAction, string> = {
  install: '安装',
  reinstall: '重装',
  upgrade: '升级',
  uninstall: '卸载',
  cleanup: '清理',
  config: '配置',
  refresh: '刷新',
  back: '返回',
  exit: '退出',
};

function itemState(item: LiveConsoleItem): LiveStatusState {
  const order: Record<LiveStatusState, number> = { absent: 0, present: 1, partial: 2, error: 3 };
  return [...item.targets].sort((left, right) => order[right.state] - order[left.state])[0]?.state
    ?? 'absent';
}

function receiptTargetLabel(entry: ReceiptTargetResult): string {
  const platform = entry.target.platform === 'codex'
    ? 'codex'
    : entry.target.platform === 'claude' ? 'claude' : 'unknown';
  const scope = entry.target.scope === 'user'
    ? 'user'
    : entry.target.scope === 'project' ? 'project' : 'unknown';
  return `${platform}/${scope}`;
}

function receiptLines(result: {
  overallState: string;
  targetResults: ReceiptTargetResult[];
  warnings?: Array<string | { message?: string }>;
  applySkippedReason?: string;
}): string[] {
  const overallState = result.overallState === 'succeeded' || result.overallState === 'failed'
    ? result.overallState
    : 'unknown';
  const lines = [`结果：${overallState}`];
  for (const entry of result.targetResults) {
    const state = entry.state === 'completed' || entry.state === 'failed' ? entry.state : 'unknown';
    lines.push(`${receiptTargetLabel(entry)}: ${state}`);
  }
  if ((result.warnings?.length ?? 0) > 0) {
    lines.push(`警告：收到 ${result.warnings!.length} 条警告，详情请查看退出后的命令结果或调试日志。`);
  }
  const applyLabels: Record<string, string> = {
    noVisibleTarget: '没有可重装的当前目标。',
    currentCatalogUnavailable: '当前 catalog 不可用。',
    noConfigChange: '配置没有变化。',
  };
  if (result.applySkippedReason && applyLabels[result.applySkippedReason]) {
    lines.push(`应用：${applyLabels[result.applySkippedReason]}`);
  }
  if (result.overallState === 'failed') lines.push('下一步：修复错误后重试，或按 r 刷新状态。');
  return lines;
}

function spinnerFrame(elapsed: number): string {
  return ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'][elapsed % 10]!;
}

function DashboardHeader(props: {
  loaded?: ConsoleItemsLoadResult;
}): React.JSX.Element {
  const catalog = props.loaded?.status.catalog;
  return (
    <Box flexDirection="column">
      <Text bold color={tuiTheme.colors.accent} wrap="truncate-end">AW</Text>
      <Text color={tuiTheme.colors.muted} wrap="truncate-end">当前项目</Text>
      <Text wrap="truncate-end">
        Catalog: {catalog?.catalogVersion ?? '未知'} · {catalog?.source ?? '未知来源'}
        {catalog?.error ? ' · Catalog 读取失败。详情请查看退出后的命令结果或调试日志。' : ''}
      </Text>
    </Box>
  );
}

function PluginList(props: {
  items: LiveConsoleItem[];
  selected: number;
  focused: boolean;
  rows: number;
}): React.JSX.Element {
  const window = viewport(props.items.length, props.selected, Math.max(0, props.rows - 1));
  return (
    <Box flexDirection="column" height={props.rows} overflow="hidden">
      <Text bold>插件</Text>
      <ViewportHint direction="up" count={window.hiddenAbove} />
      {window.indexes.map((index) => {
        const item = props.items[index]!;
        return <Text key={item.pluginName} bold={props.focused && index === props.selected} wrap="truncate-end">
          {index === props.selected ? '› ' : '  '}{item.pluginName} · {stateLabel(itemState(item))}
        </Text>;
      })}
      <ViewportHint direction="down" count={window.hiddenBelow} />
    </Box>
  );
}

function TargetList(props: {
  item?: LiveConsoleItem;
  selected: number;
  focused: boolean;
  rows: number;
}): React.JSX.Element {
  const targets = props.item?.targets ?? [];
  const window = viewport(targets.length, props.selected, Math.max(0, props.rows - 1));
  return (
    <Box flexDirection="column" height={props.rows} overflow="hidden">
      <Text bold>目标</Text>
      <ViewportHint direction="up" count={window.hiddenAbove} />
      {window.indexes.map((index) => {
        const target = targets[index]!;
        const errors = target.errors.length > 0
          ? ` · ${target.errors.map((error) => `${error.code}: ${error.message}`).join('; ')}`
          : '';
        return <Text key={targetIdentity(target)} bold={props.focused && index === props.selected} wrap="truncate-end">
          {index === props.selected ? '› ' : '  '}
          {target.target.platform}/{target.target.scope} · {stateLabel(target.state)}{errors}
        </Text>;
      })}
      <ViewportHint direction="down" count={window.hiddenBelow} />
    </Box>
  );
}

function ActionList(props: {
  actions: DashboardAction[];
  selected: number;
  focused: boolean;
  rows: number;
}): React.JSX.Element {
  const window = viewport(props.actions.length, props.selected, Math.max(0, props.rows - 1));
  return (
    <Box flexDirection="column" height={props.rows} overflow="hidden">
      <Text bold>操作</Text>
      <ViewportHint direction="up" count={window.hiddenAbove} />
      {window.indexes.map((index) => {
        const action = props.actions[index]!;
        return <Text key={action} bold={props.focused && index === props.selected} wrap="truncate-end">
          {index === props.selected ? '› ' : '  '}{actionLabels[action]}
        </Text>;
      })}
      <ViewportHint direction="down" count={window.hiddenBelow} />
    </Box>
  );
}

function targetDetailLines(
  item?: LiveConsoleItem,
  target?: LiveStatusTarget,
): Array<{ key: string; text: string; error?: boolean }> {
  return [
    { key: 'version', text: `插件版本：${item?.version ?? '未知'}` },
    ...(target ? [
      { key: 'target', text: `目标：${target.target.platform}/${target.target.scope}` },
      { key: 'state', text: `状态：${stateLabel(target.state)}` },
      ...target.components.map((component, index) => ({
        key: `component:${component.artifactKey}:${index}`,
        text: `${component.kind ?? component.artifactKey} · ${component.state === 'present' ? '●' : component.state === 'absent' ? '○' : component.state === 'partial' ? '◐' : '×'}`
          + (component.error && component.errorCode ? ` · ${component.errorCode}: ${component.error}` : ''),
        error: component.state === 'error',
      })),
      ...target.errors.map((error, index) => ({
        key: `error:${error.code}:${index}`,
        text: `错误：${error.code}: ${error.message}`,
        error: true,
      })),
      ...(target.recommendation ? [{
        key: 'recommendation',
        text: '建议：退出控制台后运行对应的修复命令。',
      }] : []),
    ] : []),
  ];
}

function TargetDetails(props: {
  item?: LiveConsoleItem;
  target?: LiveStatusTarget;
  rows: number;
  offset: number;
}): React.JSX.Element {
  const lines = targetDetailLines(props.item, props.target);
  const window = viewport(lines.length, props.offset, Math.max(0, props.rows - 1));
  return (
    <Box flexDirection="column" height={props.rows} overflow="hidden">
      <Text bold>详情</Text>
      <ViewportHint direction="up" count={window.hiddenAbove} />
      {window.indexes.map((index) => {
        const line = lines[index]!;
        return <Text key={line.key} color={line.error ? tuiTheme.statusColors.error : undefined} wrap="truncate-end">{line.text}</Text>;
      })}
      <ViewportHint direction="down" count={window.hiddenBelow} />
    </Box>
  );
}

const configLocations: Array<DashboardConfigLocation & { label: string }> = [
  { scope: 'user', projectLayer: 'shared', label: 'user' },
  { scope: 'project', projectLayer: 'shared', label: 'project/shared' },
  { scope: 'project', projectLayer: 'local', label: 'project/local' },
];

function sameLocation(left: DashboardConfigLocation, right: DashboardConfigLocation): boolean {
  return left.scope === right.scope && left.projectLayer === right.projectLayer;
}

function configLocation(entry: DashboardConfigLocation): DashboardConfigLocation {
  return { scope: entry.scope, projectLayer: entry.projectLayer };
}

function ConfigPage(props: {
  controller: DashboardController;
  item: LiveConsoleItem;
  target: LiveStatusTarget;
  rows: number;
  active: boolean;
  notices: string[];
  progress?: RebuildProgressSnapshot;
  onBack: () => void;
  onExit: () => void;
  onStatusLoaded: (loaded: ConsoleItemsLoadResult) => void;
}): React.JSX.Element {
  const initialLocation = configLocation(
    props.target.target.scope === 'project' ? configLocations[1]! : configLocations[0]!,
  );
  const [location, setLocation] = useState<DashboardConfigLocation>(initialLocation);
  const [data, setData] = useState<DashboardConfigData>();
  const [index, setIndex] = useState(0);
  const [updates, setUpdates] = useState<Record<string, unknown>>({});
  const [removeKeys, setRemoveKeys] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState(false);
  const [enumIndex, setEnumIndex] = useState(0);
  const [messageOffset, setMessageOffset] = useState(0);
  const [busy, setBusy] = useState<{ label: string; startedAt: number }>();
  const [elapsed, setElapsed] = useState(0);
  const [message, setMessage] = useState<string>();
  const [confirm, setConfirm] = useState<
    { kind: 'reset' } | { kind: 'back' } | { kind: 'exit' } | { kind: 'location'; next: DashboardConfigLocation }
  >();
  const exitAfterBusy = useRef(false);
  const dirty = Object.keys(updates).length > 0 || removeKeys.size > 0;
  const field = data?.model.fields[index];

  const finishBusy = useCallback(() => {
    const shouldExit = exitAfterBusy.current;
    exitAfterBusy.current = false;
    setBusy(undefined);
    if (shouldExit) props.onExit();
  }, [props.onExit]);

  const read = useCallback(async (next: DashboardConfigLocation) => {
    props.controller.resetProgress?.();
    setBusy({ label: '读取配置', startedAt: Date.now() });
    try {
      setData(await props.controller.readConfig(props.item, next));
      setLocation(next);
      setIndex(0);
      setUpdates({});
      setRemoveKeys(new Set());
    } catch (error) {
      await props.controller.reportError(error);
      setMessage('配置读取失败。请退出后使用 aw config list 检查，或查看调试日志。');
    } finally {
      finishBusy();
    }
  }, [finishBusy, props.controller, props.item]);

  useEffect(() => { void read(initialLocation); }, []);
  useEffect(() => {
    setMessageOffset(Math.max(0, [...(message?.split('\n') ?? []), ...props.notices].length - 8));
  }, [message, props.notices]);
  useEffect(() => {
    if (!busy) return undefined;
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - busy.startedAt) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [busy]);

  const save = useCallback(async () => {
    if (!dirty) {
      setMessage('没有待保存的变更。');
      return;
    }
    props.controller.resetProgress?.();
    setBusy({ label: `保存 ${props.item.pluginName} 配置`, startedAt: Date.now() });
    let successMessage: string | undefined;
    try {
      const receipt = await props.controller.saveConfig(props.item, location, {
        ...(Object.keys(updates).length > 0 ? { updates } : {}),
        ...(removeKeys.size > 0 ? { removeKeys: [...removeKeys] } : {}),
      });
      successMessage = ['已保存。', ...receiptLines(receipt)].join('\n');
      setUpdates({});
      setRemoveKeys(new Set());
      setEditing(false);
      setMessage(successMessage);
    } catch (error) {
      await props.controller.reportError(error);
      setMessage('配置保存失败。详细原因请查看退出后的命令结果或调试日志。');
      finishBusy();
      return;
    }

    const refreshErrors: string[] = [];
    try {
      setData(await props.controller.readConfig(props.item, location));
    } catch (error) {
      await props.controller.reportError(error);
      refreshErrors.push('配置读取失败');
    }
    try {
      props.onStatusLoaded(await props.controller.load());
    } catch (error) {
      await props.controller.reportError(error);
      refreshErrors.push('状态读取失败');
    }
    if (refreshErrors.length > 0) {
      setMessage(`已保存；自动刷新失败：${refreshErrors.join('；')}\n${successMessage}`);
    }
    finishBusy();
  }, [dirty, finishBusy, location, props.controller, props.item, props.onStatusLoaded, removeKeys, updates]);

  const reset = useCallback(async () => {
    setConfirm(undefined);
    props.controller.resetProgress?.();
    setBusy({ label: `重置 ${props.item.pluginName} 配置`, startedAt: Date.now() });
    let successMessage: string | undefined;
    try {
      const receipt = await props.controller.resetConfig(props.item, location);
      successMessage = ['已重置。', ...receiptLines(receipt)].join('\n');
      setUpdates({});
      setRemoveKeys(new Set());
      setEditing(false);
      setMessage(successMessage);
    } catch (error) {
      await props.controller.reportError(error);
      setMessage('配置重置失败。详细原因请查看退出后的命令结果或调试日志。');
      finishBusy();
      return;
    }

    const refreshErrors: string[] = [];
    try {
      setData(await props.controller.readConfig(props.item, location));
    } catch (error) {
      await props.controller.reportError(error);
      refreshErrors.push('配置读取失败');
    }
    try {
      props.onStatusLoaded(await props.controller.load());
    } catch (error) {
      await props.controller.reportError(error);
      refreshErrors.push('状态读取失败');
    }
    if (refreshErrors.length > 0) {
      setMessage(`已重置；自动刷新失败：${refreshErrors.join('；')}\n${successMessage}`);
    }
    finishBusy();
  }, [finishBusy, location, props.controller, props.item, props.onStatusLoaded]);

  function requestLeave(kind: 'back' | 'exit'): void {
    if (dirty) setConfirm({ kind });
    else if (kind === 'back') props.onBack();
    else props.onExit();
  }

  function switchLocation(delta: -1 | 1): void {
    const current = configLocations.findIndex((entry) => sameLocation(entry, location));
    const next = configLocation(configLocations[clampIndex(current + delta, configLocations.length)]!);
    if (dirty) setConfirm({ kind: 'location', next });
    else void read(next);
  }

  useInput((input, key) => {
    if (busy) {
      if (key.ctrl && input.toLowerCase() === 'c') {
        exitAfterBusy.current = true;
        setMessage('操作完成后退出。');
      }
      return;
    }
    if (confirm) {
      if (input.toLowerCase() === 'y') {
        if (confirm.kind === 'reset') void reset();
        else if (confirm.kind === 'location') {
          setConfirm(undefined);
          void read(confirm.next);
        } else if (confirm.kind === 'back') props.onBack();
        else props.onExit();
      } else if (input.toLowerCase() === 'n' || key.escape) {
        setConfirm(undefined);
      }
      return;
    }
    if (editing) {
      if (key.escape) setEditing(false);
      else if ((field?.type === 'enum' || field?.type === 'boolean') && (key.upArrow || input === 'k')) {
        const count = field.type === 'boolean' ? 2 : field.enumValues?.length ?? 0;
        setEnumIndex((value) => clampIndex(value - 1, count));
      } else if ((field?.type === 'enum' || field?.type === 'boolean') && (key.downArrow || input === 'j')) {
        const count = field.type === 'boolean' ? 2 : field.enumValues?.length ?? 0;
        setEnumIndex((value) => clampIndex(value + 1, count));
      } else if ((field?.type === 'enum' || field?.type === 'boolean') && key.return) {
        const values = field.type === 'boolean' ? [true, false] : field.enumValues ?? [];
        setUpdates((current) => ({ ...current, [field.key]: values[enumIndex] }));
        setRemoveKeys((current) => {
          const next = new Set(current); next.delete(field.key); return next;
        });
        setEditing(false);
      }
      return;
    }
    if (key.pageUp || key.pageDown) {
      setMessageOffset((value) => scrollOffset(
        value,
        messageLines.length,
        messageRows,
        key.pageUp ? -1 : 1,
      ));
    } else if (key.upArrow || input === 'k') setIndex((value) => clampIndex(value - 1, data?.model.fields.length ?? 0));
    else if (key.downArrow || input === 'j') setIndex((value) => clampIndex(value + 1, data?.model.fields.length ?? 0));
    else if (key.tab) switchLocation(key.shift ? -1 : 1);
    else if (key.return && field) {
      if (field.type === 'enum' || field.type === 'boolean') {
        const values = field.type === 'boolean' ? [true, false] : field.enumValues ?? [];
        const current = readFields.get(field.key);
        const initialValue = Object.hasOwn(updates, field.key)
          ? updates[field.key]
          : !field.sensitive && current?.storedValue !== undefined
            ? current.storedValue
            : field.defaultValue;
        const initialIndex = values.findIndex((value) => Object.is(value, initialValue));
        setEnumIndex(initialIndex < 0 ? 0 : initialIndex);
      }
      setEditing(true);
    } else if (input === 'd' && field) {
      setRemoveKeys((current) => new Set(current).add(field.key));
      setUpdates((current) => {
        const next = { ...current }; delete next[field.key]; return next;
      });
    } else if (input === 's') void save();
    else if (input === 'R') setConfirm({ kind: 'reset' });
    else if (key.escape || input === 'b') requestLeave('back');
    else if (input === 'q' || (key.ctrl && input.toLowerCase() === 'c')) requestLeave('exit');
  }, { isActive: props.active });

  function submitText(value: string): void {
    if (!field) return;
    const parsed = field.type === 'number' && value.trim() !== '' ? Number(value) : value;
    setUpdates((current) => ({ ...current, [field.key]: parsed }));
    setRemoveKeys((current) => {
      const next = new Set(current); next.delete(field.key); return next;
    });
    setEditing(false);
  }

  const readFields = new Map(data?.read.fields.map((entry) => [entry.key, entry]));
  const storedTextEditorValue = field ? readFields.get(field.key)?.storedValue : undefined;
  const textEditorCurrentValue = storedTextEditorValue ?? field?.defaultValue;
  const locationLabel = configLocations.find((entry) => sameLocation(entry, location))?.label;
  const messageLines = [...(message?.split('\n') ?? []), ...props.notices];
  const messageRows = Math.min(8, messageLines.length);
  const transientRows = busy || confirm ? 1 : 0;
  const editorValues = editing && field
    ? field.type === 'boolean' ? [true, false] : field.type === 'enum' ? field.enumValues ?? [] : []
    : [];
  const editorRows = editing ? Math.min(4, Math.max(1, editorValues.length + 1)) : 0;
  const fieldRows = Math.max(1, props.rows - 2 - transientRows - editorRows - messageRows - 1);
  const fieldWindow = viewport(data?.model.fields.length ?? 0, index, fieldRows);
  const editorWindow = viewport(editorValues.length, enumIndex, Math.max(0, editorRows - 1));
  const clampedMessageOffset = Math.min(messageOffset, Math.max(0, messageLines.length - messageRows));
  const messageWindow = messageViewport(messageLines.length, clampedMessageOffset, messageRows);
  useEffect(() => {
    if (messageOffset !== clampedMessageOffset) setMessageOffset(clampedMessageOffset);
  }, [clampedMessageOffset, messageOffset, messageRows]);
  return (
    <Box flexDirection="column" paddingX={1} height={props.rows} overflow="hidden">
      <Text bold color={tuiTheme.colors.accent} wrap="truncate-end">AW · {props.item.pluginName} 配置</Text>
      <Text wrap="truncate-end">位置：{locationLabel}（Tab/Shift+Tab 切换）</Text>
      {busy ? <Text wrap="truncate-end">
        {spinnerFrame(elapsed)} {props.progress?.current
          ? `${props.progress.current.target} · ${props.progress.current.phase}`
          : busy.label} · {elapsed}s
      </Text> : null}
      {confirm ? <Text color={tuiTheme.statusColors.warning}>
        {confirm.kind === 'reset' ? '确认重置当前层？' : '有未保存变更，确认放弃？'} y/n
      </Text> : null}
      <ViewportHint direction="up" count={fieldWindow.hiddenAbove} />
      {fieldWindow.indexes.map((fieldIndex) => {
        const entry = data!.model.fields[fieldIndex]!;
        const current = readFields.get(entry.key);
        const privateValue = entry.sensitive || entry.type === 'file' || entry.type === 'directory';
        const staged = Object.hasOwn(updates, entry.key)
          ? privateValue ? '待更新' : String(updates[entry.key])
          : removeKeys.has(entry.key) ? '待清除'
            : privateValue
              ? (current?.effectiveValue !== undefined && current.effectiveValue !== null ? '已配置' : '未配置')
              : String(current?.effectiveValue ?? '未配置');
        return <Text key={entry.key} bold={fieldIndex === index} wrap="truncate-end">
          {fieldIndex === index ? '› ' : '  '}{entry.label}{entry.required ? ' · 必填' : ''}
          {' · '}{current?.sourceLayer ?? 'missing'}/{current?.valueState ?? 'missing'} · {staged}
        </Text>;
      })}
      <ViewportHint direction="down" count={fieldWindow.hiddenBelow} />
      {editing && (field?.type === 'enum' || field?.type === 'boolean') ? (
        <Box flexDirection="column" height={editorRows} overflow="hidden">
          <Text wrap="truncate-end">选择 {field.label}</Text>
          <ViewportHint direction="up" count={editorWindow.hiddenAbove} />
          {editorWindow.indexes.map((valueIndex) => (
            <Text key={String(editorValues[valueIndex])} bold={valueIndex === enumIndex} wrap="truncate-end">
              {valueIndex === enumIndex ? '› ' : '  '}{String(editorValues[valueIndex])}
            </Text>
          ))}
          <ViewportHint direction="down" count={editorWindow.hiddenBelow} />
        </Box>
      ) : null}
      {editing && field && field.type !== 'enum' && field.type !== 'boolean'
        ? field.sensitive || field.type === 'file' || field.type === 'directory'
          ? <PasswordInput onSubmit={submitText} />
          : <TextInput
              defaultValue={Object.hasOwn(updates, field.key)
                ? String(updates[field.key])
                : textEditorCurrentValue === undefined || textEditorCurrentValue === null
                  ? undefined
                  : String(textEditorCurrentValue)}
              onSubmit={submitText}
            />
        : null}
      <ViewportHint direction="up" count={messageWindow.hiddenAbove} />
      {messageWindow.indexes.map((messageIndex) => (
        <Text key={`${messageIndex}:${messageLines[messageIndex]}`} wrap="truncate-end">{messageLines[messageIndex]}</Text>
      ))}
      <ViewportHint direction="down" count={messageWindow.hiddenBelow} />
      <Text color={tuiTheme.colors.muted} wrap="truncate-end">↑/↓ jk 字段 · PgUp/PgDn 消息 · Enter 编辑 · d 清除 · s 保存 · R 重置 · Esc/b 返回</Text>
    </Box>
  );
}

export function Dashboard(props: {
  controller: DashboardController;
  onComplete: (result: DashboardResult) => void;
  size?: { columns: number; rows: number };
}): React.JSX.Element {
  const windowSize = useWindowSize();
  const size = props.size ?? windowSize;
  const policy = resolveTuiSizePolicy(size.columns, size.rows);
  const [state, dispatch] = useReducer(dashboardReducer, undefined, createInitialDashboardState);
  const [elapsed, setElapsed] = useState(0);
  const [detailsOffset, setDetailsOffset] = useState(0);
  const [outputOffset, setOutputOffset] = useState(0);
  const [sessionProgress, setSessionProgress] = useState<RebuildProgressSnapshot>(
    () => props.controller.getProgress?.() ?? { messages: props.controller.getNotices?.() ?? [] },
  );
  const exitAfterBusy = useRef(false);
  const loadSequence = useRef(0);
  const loadPending = useRef(false);

  const load = useCallback(async (): Promise<boolean> => {
    const sequence = ++loadSequence.current;
    loadPending.current = true;
    dispatch({ type: 'load-start' });
    try {
      const loaded = await props.controller.load();
      if (sequence !== loadSequence.current) return true;
      dispatch({ type: 'load-success', loaded });
      return true;
    } catch (error) {
      await props.controller.reportError(error);
      if (sequence !== loadSequence.current) return true;
      dispatch({ type: 'load-error', message: '状态读取失败。请退出后使用 aw status 检查，或查看调试日志。' });
      return false;
    } finally {
      if (sequence === loadSequence.current) loadPending.current = false;
    }
  }, [props.controller]);

  useEffect(() => {
    if (props.controller.subscribeProgress) {
      return props.controller.subscribeProgress(setSessionProgress);
    }
    return props.controller.subscribeNotices?.((messages) => setSessionProgress({ messages }));
  }, [props.controller]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!state.busy) return undefined;
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - state.busy!.startedAt) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [state.busy]);

  const item = selectedItem(state);
  const target = selectedTarget(state);
  const actions = selectedActions(state);

  useEffect(() => { setDetailsOffset(0); }, [state.page, state.selectedPluginName, state.selectedTargetId]);
  useEffect(() => {
    const count = [
      ...(state.notice?.split('\n') ?? []),
      ...sessionProgress.messages,
      ...(state.loadError ? [state.loadError] : []),
      ...(state.loaded?.status.errors ?? []),
    ].length;
    setOutputOffset(Math.max(0, count - 8));
  }, [state.notice, sessionProgress, state.loadError, state.loaded?.status.errors]);

  const busyText = state.busy
    ? `${spinnerFrame(elapsed)} ${sessionProgress.current
      ? `${sessionProgress.current.target} · ${sessionProgress.current.phase}`
      : `${state.busy.action} · ${state.busy.target}`} · ${elapsed}s${state.busy.exitAfter ? ' · 完成后退出' : ''}`
    : undefined;
  const activityText = busyText
    ?? (state.confirm
      ? `确认${actionLabels[state.confirm]} ${target?.target.plugin} ${target?.target.platform}/${target?.target.scope}？ y/n`
      : state.loading ? '⠋ 正在刷新状态…' : undefined);
  const outputLines = [
    ...(state.notice?.split('\n') ?? []),
    ...sessionProgress.messages,
    ...(state.loadError ? [`错误：${state.loadError}`] : []),
    ...(state.loaded?.status.errors.map(() => '错误：状态读取失败。详情请查看退出后的命令结果或调试日志。') ?? []),
  ];
  const outputRows = Math.min(8, outputLines.length);
  const clampedOutputOffset = Math.min(outputOffset, Math.max(0, outputLines.length - outputRows));
  const outputWindow = messageViewport(outputLines.length, clampedOutputOffset, outputRows);
  const outputHintRows = Number(outputWindow.hiddenAbove > 0) + Number(outputWindow.hiddenBelow > 0);
  const bodyRows = Math.max(1, policy.rows - 3 - (activityText ? 1 : 0) - outputRows - outputHintRows - 1);
  const innerPanelRows = Math.max(1, bodyRows - (policy.mode === 'three-column' ? 2 : 0));
  const targetListRows = Math.min(4, Math.max(2, Math.floor(innerPanelRows / 2)));
  const detailsRows = Math.max(0, innerPanelRows - targetListRows);
  const detailLines = targetDetailLines(item, target);
  const clampedDetailsOffset = Math.min(detailsOffset, Math.max(0, detailLines.length - 1));
  useEffect(() => {
    if (outputOffset !== clampedOutputOffset) setOutputOffset(clampedOutputOffset);
    if (detailsOffset !== clampedDetailsOffset) setDetailsOffset(clampedDetailsOffset);
  }, [clampedDetailsOffset, clampedOutputOffset, detailsOffset, outputOffset]);

  const execute = useCallback(async (action: DashboardWriteAction) => {
    if (!target || loadPending.current) return;
    props.controller.resetProgress?.();
    dispatch({
      type: 'busy-start',
      action: actionLabels[action],
      target: `${target.target.plugin} ${target.target.platform}/${target.target.scope}`,
      startedAt: Date.now(),
    });
    let notice: string;
    try {
      notice = receiptLines(await props.controller.execute(action, target)).join('\n');
    } catch (error) {
      await props.controller.reportError(error);
      notice = '操作失败。详细原因请查看退出后的命令结果或调试日志。\n下一步：修复错误后重试，或按 r 刷新状态。';
    }
    if (!(await load())) {
      notice += '\n自动刷新失败。请退出后使用 aw status 检查，或查看调试日志。';
    }
    dispatch({ type: 'busy-end', notice });
    const shouldExit = exitAfterBusy.current;
    exitAfterBusy.current = false;
    if (shouldExit) props.onComplete({ exitCode: 0 });
  }, [load, props.controller, props.onComplete, target]);

  function activateAction(action: DashboardAction | undefined): void {
    if (!action) return;
    if (action === 'exit') props.onComplete({ exitCode: 0 });
    else if (action === 'back') {
      dispatch({ type: 'focus', region: 'targets' });
      dispatch({ type: 'single-page', page: 'targets' });
    } else if (action === 'refresh') void load();
    else if (action === 'config') dispatch({ type: 'page', page: 'config' });
    else if (action === 'uninstall' || action === 'cleanup') dispatch({ type: 'confirm', action });
    else void execute(action);
  }

  useInput((input, key) => {
    if (state.page === 'config') return;
    if (state.busy) {
      if (key.ctrl && input.toLowerCase() === 'c') {
        exitAfterBusy.current = true;
        dispatch({ type: 'busy-exit-after' });
      }
      return;
    }
    if (state.confirm) {
      if (input.toLowerCase() === 'y') void execute(state.confirm);
      else if (input.toLowerCase() === 'n' || key.escape) dispatch({ type: 'confirm' });
      return;
    }
    if (input === 'q' || (key.ctrl && input.toLowerCase() === 'c')) {
      props.onComplete({ exitCode: 0 });
      return;
    }
    if (input === 'r') { void load(); return; }
    if (state.loading || loadPending.current) return;
    if (key.pageUp || key.pageDown) {
      setOutputOffset((value) => scrollOffset(value, outputLines.length, outputRows, key.pageUp ? -1 : 1));
      return;
    }
    if (input === '[' || input === ']') {
      setDetailsOffset((value) => scrollOffset(value, detailLines.length, detailsRows, input === '[' ? -1 : 1));
      return;
    }
    const currentRegion = policy.mode === 'single-column' ? state.singlePage : state.focus;
    if (key.upArrow || input === 'k') dispatch({ type: 'move', region: currentRegion, delta: -1 });
    else if (key.downArrow || input === 'j') dispatch({ type: 'move', region: currentRegion, delta: 1 });
    else if (key.tab || input === 'h' || input === 'l') {
      const regions: FocusRegion[] = ['plugins', 'targets', 'actions'];
      const current = regions.indexOf(currentRegion);
      const delta = key.shift || input === 'h' ? -1 : 1;
      const next = regions[clampIndex(current + delta, regions.length)]!;
      dispatch({ type: policy.mode === 'single-column' ? 'single-page' : 'focus',
        ...(policy.mode === 'single-column' ? { page: next } : { region: next }) } as DashboardStateAction);
    } else if (key.escape || input === 'b') {
      if (currentRegion === 'actions') {
        dispatch({ type: policy.mode === 'single-column' ? 'single-page' : 'focus',
          ...(policy.mode === 'single-column' ? { page: 'targets' } : { region: 'targets' }) } as DashboardStateAction);
      } else if (currentRegion === 'targets') {
        dispatch({ type: policy.mode === 'single-column' ? 'single-page' : 'focus',
          ...(policy.mode === 'single-column' ? { page: 'plugins' } : { region: 'plugins' }) } as DashboardStateAction);
      }
    } else if (key.return) {
      if (currentRegion === 'plugins') {
        dispatch({ type: policy.mode === 'single-column' ? 'single-page' : 'focus',
          ...(policy.mode === 'single-column' ? { page: 'targets' } : { region: 'targets' }) } as DashboardStateAction);
      } else if (currentRegion === 'targets') {
        dispatch({ type: policy.mode === 'single-column' ? 'single-page' : 'focus',
          ...(policy.mode === 'single-column' ? { page: 'actions' } : { region: 'actions' }) } as DashboardStateAction);
      } else activateAction(actions[state.actionIndex]);
    }
  });

  if (state.page === 'config' && item && target) {
    const active = policy.mode !== 'too-small';
    return <Box flexDirection="column" height={policy.rows} overflow="hidden">
      {active ? null : (
        <Box flexDirection="column" paddingX={1}>
          <Text bold color={tuiTheme.colors.accent}>AW</Text>
          <Text color={tuiTheme.statusColors.warning}>{policy.message}</Text>
          <Text>当前：{policy.columns} 列 × {policy.rows} 行。调整尺寸后自动恢复。</Text>
        </Box>
      )}
      <Box display={active ? 'flex' : 'none'}>
        <ConfigPage
          controller={props.controller}
          item={item}
          target={target}
          rows={policy.rows}
          active={active}
          notices={sessionProgress.messages}
          progress={sessionProgress}
          onBack={() => dispatch({ type: 'page', page: 'dashboard' })}
          onExit={() => props.onComplete({ exitCode: 0 })}
          onStatusLoaded={(loaded) => dispatch({ type: 'load-success', loaded })}
        />
      </Box>
    </Box>;
  }

  if (policy.mode === 'too-small') {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold color={tuiTheme.colors.accent}>AW</Text>
        <Text color={tuiTheme.statusColors.warning}>{policy.message}</Text>
        <Text>当前：{policy.columns} 列 × {policy.rows} 行。调整尺寸后自动恢复。</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1} height={policy.rows} overflow="hidden">
      <DashboardHeader loaded={state.loaded} />
      {activityText ? <Text color={state.confirm ? tuiTheme.statusColors.warning : undefined} wrap="truncate-end">{activityText}</Text> : null}
      {policy.mode === 'three-column' ? (
        <Box height={bodyRows} overflow="hidden">
          <Box width={28} borderStyle="single" borderColor={state.focus === 'plugins' ? tuiTheme.colors.accent : tuiTheme.colors.border} paddingX={1}>
            <PluginList items={state.loaded?.items ?? []} selected={state.pluginIndex} focused={state.focus === 'plugins'} rows={innerPanelRows} />
          </Box>
          <Box width={24} borderStyle="single" borderColor={state.focus === 'actions' ? tuiTheme.colors.accent : tuiTheme.colors.border} paddingX={1}>
            <ActionList actions={actions} selected={state.actionIndex} focused={state.focus === 'actions'} rows={innerPanelRows} />
          </Box>
          <Box flexGrow={1} borderStyle="single" borderColor={state.focus === 'targets' ? tuiTheme.colors.accent : tuiTheme.colors.border} paddingX={1}>
            <TargetList item={item} selected={state.targetIndex} focused={state.focus === 'targets'} rows={targetListRows} />
            <TargetDetails item={item} target={target} rows={detailsRows} offset={clampedDetailsOffset} />
          </Box>
        </Box>
      ) : state.singlePage === 'plugins' ? (
        <PluginList items={state.loaded?.items ?? []} selected={state.pluginIndex} focused rows={bodyRows} />
      ) : state.singlePage === 'targets' ? (
        <Box flexDirection="column" height={bodyRows} overflow="hidden">
          <TargetList item={item} selected={state.targetIndex} focused rows={targetListRows} />
          <TargetDetails item={item} target={target} rows={Math.max(0, bodyRows - targetListRows)} offset={clampedDetailsOffset} />
        </Box>
      ) : (
        <ActionList actions={actions} selected={state.actionIndex} focused rows={bodyRows} />
      )}
      <ViewportHint direction="up" count={outputWindow.hiddenAbove} />
      {outputWindow.indexes.map((index) => (
        <Text key={`${index}:${outputLines[index]}`} wrap="truncate-end">{outputLines[index]}</Text>
      ))}
      <ViewportHint direction="down" count={outputWindow.hiddenBelow} />
      <Text color={tuiTheme.colors.muted} wrap="truncate-end">↑/↓ jk 移动 · [/] 详情 · PgUp/PgDn 输出 · Tab/Shift+Tab h/l 区域 · Enter 选择 · Esc/b 返回 · r 刷新 · q 退出</Text>
    </Box>
  );
}
