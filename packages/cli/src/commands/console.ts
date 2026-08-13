import { createElement } from 'react';

import {
  type CliExecutionContext,
  type CommandNotice,
  type CommandReporter,
  withCommandReporterSession,
} from './runtime.js';
import type { RebuildCommandResult } from './rebuild-command.js';
import {
  loadConsoleItemsResult,
  type ConsoleItemsLoadResult,
  type LiveConsoleItem,
  type LiveStatusState,
  type LiveStatusTarget,
} from './status.js';
import {
  cleanupWriteCommand,
  installWriteCommand,
  reinstallWriteCommand,
  uninstallWriteCommand,
  upgradeWriteCommand,
} from './write-commands.js';

import type { Scope } from '../types.js';
import {
  createPluginConfigFormModel,
  resolveConfigRead,
  resolveEffectivePluginConfig,
  type PluginConfigFormModel,
  type ProjectConfigStoreLayer,
  type ResolvedConfigRead,
} from '../utils/plugin-config.js';
import {
  applyPluginConfigWrite,
  resetPluginConfigWithHelper,
  type PluginConfigWriteReceipt,
  type ResetPluginConfigWriteReceipt,
} from '../utils/plugin-config-write.js';
import { Dashboard, type DashboardResult } from '../tui/dashboard.js';
import { formatNotice } from '../output/reporter.js';

export type DashboardWriteAction =
  | 'install'
  | 'reinstall'
  | 'upgrade'
  | 'uninstall'
  | 'cleanup';

export type DashboardAction = DashboardWriteAction | 'config' | 'refresh' | 'back' | 'exit';

export interface DashboardConfigLocation {
  scope: Scope;
  projectLayer: ProjectConfigStoreLayer;
}

export interface DashboardConfigData {
  model: PluginConfigFormModel;
  read: ResolvedConfigRead;
  location: DashboardConfigLocation;
}

export interface DashboardController {
  cwd: string;
  getNotices?: () => string[];
  subscribeNotices?: (listener: (notices: string[]) => void) => () => void;
  load: () => Promise<ConsoleItemsLoadResult>;
  execute: (
    action: DashboardWriteAction,
    target: LiveStatusTarget,
  ) => Promise<RebuildCommandResult>;
  readConfig: (
    item: LiveConsoleItem,
    location: DashboardConfigLocation,
  ) => Promise<DashboardConfigData>;
  saveConfig: (
    item: LiveConsoleItem,
    location: DashboardConfigLocation,
    request: { updates?: Record<string, unknown>; removeKeys?: string[] },
  ) => Promise<PluginConfigWriteReceipt>;
  resetConfig: (
    item: LiveConsoleItem,
    location: DashboardConfigLocation,
  ) => Promise<ResetPluginConfigWriteReceipt>;
}

interface DashboardNoticeFeed {
  add: (notice: CommandNotice) => void;
  get: () => string[];
  subscribe: (listener: (notices: string[]) => void) => () => void;
}

function createDashboardNoticeFeed(limit = 20): DashboardNoticeFeed {
  let notices: string[] = [];
  const listeners = new Set<(value: string[]) => void>();
  return {
    add(notice) {
      const line = formatNotice(notice);
      if (notices.includes(line)) return;
      notices = [...notices, line].slice(-limit);
      for (const listener of listeners) listener(notices);
    },
    get: () => notices,
    subscribe(listener) {
      listeners.add(listener);
      listener(notices);
      return () => listeners.delete(listener);
    },
  };
}

export function stateLabel(state: LiveStatusState): string {
  switch (state) {
    case 'present': return '● 已就绪';
    case 'absent': return '○ 未安装';
    case 'partial': return '◐ 不完整';
    case 'error': return '× 检查失败';
  }
}

export function targetIdentity(target: LiveStatusTarget): string {
  return `${target.target.plugin}\0${target.target.platform}\0${target.target.scope}`;
}

export function dashboardActions(
  item: LiveConsoleItem,
  target: LiveStatusTarget,
): DashboardAction[] {
  const actions: DashboardAction[] = [];
  if (target.state === 'absent') actions.push('install');
  if (target.state === 'present' || target.state === 'partial') actions.push('reinstall');
  if (target.state === 'present') actions.push('upgrade', 'uninstall');
  if (target.state !== 'absent') actions.push('cleanup');
  if (item.plugin?.manifest.config?.schema) actions.push('config');
  actions.push('refresh', 'back', 'exit');
  return actions;
}

export function createDashboardController(
  context: CliExecutionContext,
  noticeFeed?: DashboardNoticeFeed,
): DashboardController {
  return {
    cwd: context.cwd,
    ...(noticeFeed ? {
      getNotices: noticeFeed.get,
      subscribeNotices: noticeFeed.subscribe,
    } : {}),
    load: () => loadConsoleItemsResult({
      cwd: context.cwd,
      includeCatalogOnly: true,
    }, context),
    async execute(action, target) {
      const options = {
        cwd: context.cwd,
        platform: target.target.platform,
        scope: target.target.scope,
      };
      switch (action) {
        case 'install': return installWriteCommand([target.target.plugin], options, context);
        case 'reinstall': return reinstallWriteCommand([target.target.plugin], options, context);
        case 'upgrade': return upgradeWriteCommand([target.target.plugin], options, context);
        case 'uninstall': return uninstallWriteCommand([target.target.plugin], options, context);
        case 'cleanup': return cleanupWriteCommand([target.target.plugin], options, context);
      }
    },
    async readConfig(item, location) {
      if (!item.plugin?.manifest.config?.schema) {
        throw new Error(`Plugin "${item.pluginName}" 没有配置 schema。`);
      }
      const effective = await resolveEffectivePluginConfig({
        pluginName: item.pluginName,
        manifest: item.plugin.manifest,
        cwd: context.cwd,
        env: context.env,
      });
      const model = createPluginConfigFormModel({
        pluginName: item.pluginName,
        manifest: item.plugin.manifest,
        effective,
        initialScope: location.scope,
      });
      const read = await resolveConfigRead({
        pluginName: item.pluginName,
        plugin: item.plugin,
        scope: location.scope,
        projectLayer: location.projectLayer,
        cwd: context.cwd,
        env: context.env,
      });
      return { model, read, location };
    },
    saveConfig: (item, location, request) => applyPluginConfigWrite({
      pluginName: item.pluginName,
      plugin: item.plugin,
      scope: location.scope,
      projectLayer: location.projectLayer,
      cwd: context.cwd,
      env: context.env,
      nativeCliRunner: context.nativeCliRunner,
      rebuildRuntime: context,
      request,
    }),
    resetConfig: (item, location) => resetPluginConfigWithHelper({
      pluginName: item.pluginName,
      plugin: item.plugin,
      scope: location.scope,
      projectLayer: location.projectLayer,
      cwd: context.cwd,
      env: context.env,
      nativeCliRunner: context.nativeCliRunner,
      rebuildRuntime: context,
    }),
  };
}

export function formatInteractiveConsoleUnavailableMessage(
  context: Pick<CliExecutionContext, 'isCi' | 'isTty'>,
): string {
  const reasons = [
    context.isCi ? 'CI 环境默认禁用交互控制台。' : undefined,
    !context.isTty ? '当前 stdin/stdout 不是可交互终端。' : undefined,
  ].filter(Boolean);
  return [
    '当前运行环境不可交互，不能进入 aw 控制台。',
    ...reasons,
    '',
    '可用命令：',
    '- `aw status`',
    '- `aw install <plugin> --platform codex --scope user`',
    '- `aw status --json`',
  ].join('\n');
}

export async function runConsoleController(context: CliExecutionContext): Promise<number> {
  const noticeFeed = createDashboardNoticeFeed();
  const controller = createDashboardController(context, noticeFeed);
  const sessionReporter: CommandReporter = {
    event: () => {},
    notice: (notice) => noticeFeed.add(notice),
  };
  const result = await withCommandReporterSession(context.reporter, sessionReporter, () =>
    context.tuiRunner.launch<DashboardResult>({
      input: context.stdin,
      output: context.tuiOutput,
      render: (complete) => createElement(Dashboard, { controller, onComplete: complete }),
    }));
  return result.exitCode;
}
