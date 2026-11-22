import type { RebuildActionName } from '../types.js';
import type { InstallTaskProgress } from '../recovery/install-concurrency.js';
import type { CommandEvent, CommandNotice, RebuildActionEvent } from './model.js';
import { isPlatformTarget } from '@lesliechan721/aw-plugin-core';
import { TARGET_DISPLAY_NAMES } from '../platforms/discovery.js';
import { CATALOG_SOURCE_ID_PATTERN } from '../utils/catalog-sources.js';

const ACTION_LABELS: Record<RebuildActionName, string> = {
  'preflight.inspect': '检查当前组件',
  'stale.cleanup': '清理过期组件',
  'native.write': '写入平台插件',
  'artifacts.write': '写入插件文件',
  preApply: '运行 preApply',
  'postcheck.inspect': '检查写入结果',
  'recovery.cleanup': '清理失败写入',
  'cleanup.owned': '清理 AW 组件',
};

const SAFE_PLUGIN_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function safeNoticeSource(notice: CommandNotice): string | undefined {
  const parts = [
    isPlatformTarget(notice.source?.platform) ? TARGET_DISPLAY_NAMES[notice.source.platform] : undefined,
    typeof notice.source?.plugin === 'string' && SAFE_PLUGIN_NAME_PATTERN.test(notice.source.plugin)
      ? notice.source.plugin
      : undefined,
    notice.source?.scope === 'project'
      ? '当前项目'
      : notice.source?.scope === 'user' ? '当前用户' : undefined,
  ].filter((part): part is string => part !== undefined);
  return parts.length > 0 ? parts.join(' / ') : undefined;
}

export function projectTuiNotice(notice: CommandNotice): string {
  const source = safeNoticeSource(notice);
  const kind = notice.level === 'warning' ? '警告' : '通知';
  return `${kind}：${source ? `${source}：` : ''}收到${kind}，详情请查看退出后的命令结果或调试日志。`;
}

export interface RebuildProgressCurrent {
  target: string;
  phase: string;
}

export interface RebuildProgressSnapshot {
  current?: RebuildProgressCurrent;
  installProgress?: InstallTaskProgress;
  messages: string[];
  startedAtMs?: number;
  elapsedMs?: number;
}

export interface RebuildProgressFeed {
  addEvent: (event: CommandEvent) => void;
  addNotice: (notice: CommandNotice) => void;
  setCurrent: (current: RebuildProgressCurrent, message?: string) => void;
  setInstallProgress: (progress: InstallTaskProgress) => void;
  clearCurrent: () => void;
  get: () => RebuildProgressSnapshot;
  subscribe: (listener: (snapshot: RebuildProgressSnapshot) => void) => () => void;
}

function isRebuildActionEvent(event: CommandEvent): event is RebuildActionEvent {
  if (event.type !== 'rebuild:action' || !event.source || !event.data) return false;
  const data = event.data as Partial<RebuildActionEvent['data']>;
  return typeof event.source.plugin === 'string'
    && SAFE_PLUGIN_NAME_PATTERN.test(event.source.plugin)
    && isPlatformTarget(event.source.platform)
    && (event.source.scope === 'user' || event.source.scope === 'project')
    && typeof data.name === 'string'
    && Object.hasOwn(ACTION_LABELS, data.name)
    && (data.phase === 'start' || data.phase === 'success' || data.phase === 'failure');
}

function targetLabel(event: RebuildActionEvent): string {
  const platform = TARGET_DISPLAY_NAMES[event.source.platform];
  const scope = event.source.scope === 'project' ? '当前项目' : '当前用户';
  return `${event.source.plugin} · ${platform}/${scope}`;
}

function actionLine(event: RebuildActionEvent): { current: RebuildProgressCurrent; line: string } {
  const target = targetLabel(event);
  const action = ACTION_LABELS[event.data.name];
  if (event.data.phase === 'start') {
    return {
      current: { target, phase: action },
      line: `开始：${target} · ${action}`,
    };
  }
  const duration = `${Math.max(0, Math.round(event.data.durationMs))}ms`;
  if (event.data.phase === 'success') {
    return {
      current: { target, phase: `${action}已完成` },
      line: `完成：${target} · ${action} · ${duration}`,
    };
  }
  return {
    current: { target, phase: `${action}失败` },
    line: `失败：${target} · ${action}失败。 · ${duration} · 详细原因请查看退出后的命令结果或调试日志。`,
  };
}

export function createRebuildProgressFeed(limit = 50): RebuildProgressFeed {
  let snapshot: RebuildProgressSnapshot = { messages: [] };
  const seenNoticeKeys = new Set<string>();
  const noticeKeyOrder: string[] = [];
  const listeners = new Set<(value: RebuildProgressSnapshot) => void>();

  function publish(next: RebuildProgressSnapshot): void {
    snapshot = {
      ...(next.current ? { current: next.current } : {}),
      ...(next.installProgress ? { installProgress: next.installProgress } : {}),
      messages: next.messages.slice(-limit),
    };
    for (const listener of listeners) listener(snapshot);
  }

  return {
    addEvent(event) {
      if (event.type === 'managed-command:producer' && event.source
        && typeof event.source.plugin === 'string'
        && SAFE_PLUGIN_NAME_PATTERN.test(event.source.plugin)
        && event.source.scope === 'user' && event.data) {
        const data = event.data as Record<string, unknown>;
        if (typeof data.selector !== 'string' || !['start', 'success', 'failure'].includes(String(data.phase))) return;
        const sourceId = data.selector.split('/', 1)[0]!;
        if (!CATALOG_SOURCE_ID_PATTERN.test(sourceId) || data.selector !== `${sourceId}/${event.source.plugin}`) return;
        const target = `命令包 ${data.selector}`;
        const phase = data.phase === 'start' ? '刷新命令包'
          : data.phase === 'success' ? '命令包已完成' : '命令包失败';
        publish({ ...snapshot, current: { target, phase }, messages: [...snapshot.messages, `${target} · ${phase}`] });
        return;
      }
      if (!isRebuildActionEvent(event)) return;
      const entry = actionLine(event);
      publish({ ...snapshot, current: entry.current, messages: [...snapshot.messages, entry.line] });
    },
    addNotice(notice) {
      const line = projectTuiNotice(notice);
      const key = notice.identity ?? [
        notice.level,
        notice.source?.platform ?? '',
        notice.source?.plugin ?? '',
        notice.source?.scope ?? '',
        notice.message,
      ].join(':');
      if (seenNoticeKeys.has(key)) return;
      seenNoticeKeys.add(key);
      noticeKeyOrder.push(key);
      while (noticeKeyOrder.length > limit) {
        seenNoticeKeys.delete(noticeKeyOrder.shift()!);
      }
      publish({ ...snapshot, messages: [...snapshot.messages, line] });
    },
    setCurrent(current, message) {
      publish({
        ...snapshot,
        current,
        messages: message ? [...snapshot.messages, message] : snapshot.messages,
      });
    },
    setInstallProgress(progress) {
      const previous = snapshot.installProgress;
      if (progress.completed + progress.running + progress.waiting + progress.waitingForDependencies < 2
        || (previous?.completed === progress.completed && previous.running === progress.running
          && previous.waiting === progress.waiting && previous.waitingForDependencies === progress.waitingForDependencies)) return;
      publish({ ...snapshot, installProgress: { ...progress } });
    },
    clearCurrent() {
      seenNoticeKeys.clear();
      noticeKeyOrder.length = 0;
      publish({ messages: [] });
    },
    get: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      listener(snapshot);
      return () => listeners.delete(listener);
    },
  };
}
