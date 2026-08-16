import { createElement } from 'react';

import {
  type CliExecutionContext,
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
  type PluginConfigWriteReceipt,
  type ResetPluginConfigWriteReceipt,
} from '../utils/plugin-config-write.js';
import {
  assertCatalogSourceReferencesSupported,
  inventoryLegacyConfigReferences,
} from '../utils/catalog-source-references.js';
import { readCliPackageInfo } from '../utils/local-marketplace.js';
import { withResolvedCatalogPlugin } from '../utils/multi-source-catalog.js';
import { Dashboard, type DashboardResult } from '../tui/dashboard.js';
import {
  createRebuildProgressFeed,
  type RebuildProgressFeed,
  type RebuildProgressSnapshot,
} from '../output/rebuild-progress.js';
import { redactValue } from '../output/redact.js';

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
  getProgress?: () => RebuildProgressSnapshot;
  subscribeProgress?: (listener: (progress: RebuildProgressSnapshot) => void) => () => void;
  resetProgress?: () => void;
  load: () => Promise<ConsoleItemsLoadResult>;
  execute: (
    action: DashboardWriteAction,
    target: LiveStatusTarget,
  ) => Promise<RebuildCommandResult>;
  reportError: (error: unknown) => Promise<void>;
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

function hasConfigSchemaKeys(item: LiveConsoleItem): boolean {
  const schema = item.plugin?.manifest.config?.schema ?? item.pluginSummary?.configSchema;
  return schema !== undefined && Object.keys(schema).length > 0;
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
  if (hasConfigSchemaKeys(item)) actions.push('config');
  actions.push('refresh', 'back', 'exit');
  return actions;
}

export function createDashboardController(
  context: CliExecutionContext,
  progressFeed?: RebuildProgressFeed,
): DashboardController {
  return {
    cwd: context.cwd,
    ...(progressFeed ? {
      getNotices: () => progressFeed.get().messages,
      subscribeNotices: (listener: (notices: string[]) => void) => progressFeed.subscribe(
        (progress) => listener(progress.messages),
      ),
      getProgress: progressFeed.get,
      subscribeProgress: progressFeed.subscribe,
      resetProgress: progressFeed.clearCurrent,
    } : {}),
    load: () => loadConsoleItemsResult({
      cwd: context.cwd,
      includeCatalogOnly: true,
    }, context),
    async execute(action, target) {
      if (target.target.plugin.includes('/')) {
        throw new Error('runtimeTransitionIncomplete: interactive writes require the phase 3B namespaced runtime.');
      }
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
    async reportError(error) {
      const diagnostic = redactValue({
        type: 'command:error',
        commandName: context.diagnostics.commandName,
        message: error instanceof Error ? error.message : String(error),
        data: error instanceof Error
          ? { name: error.name, stack: error.stack }
          : undefined,
      }) as Parameters<typeof context.debugLogger.log>[0];
      await Promise.allSettled([
        Promise.resolve().then(() => context.reporter.event({
          type: 'command:error',
          commandName: context.diagnostics.commandName,
          message: '控制台操作失败。',
          data: { name: 'DashboardWriteError' },
        })),
        Promise.resolve().then(() => context.debugLogger.log(diagnostic)),
      ]);
    },
    async readConfig(item, location) {
      if (!hasConfigSchemaKeys(item)) {
        throw new Error(`Plugin "${item.pluginName}" 没有配置 schema。`);
      }
      const project = async (pluginName: string, plugin: NonNullable<LiveConsoleItem['plugin']>) => {
        const effective = await resolveEffectivePluginConfig({
          pluginName,
          manifest: plugin.manifest,
          cwd: context.cwd,
          env: context.env,
        });
        const model = createPluginConfigFormModel({
          pluginName,
          manifest: plugin.manifest,
          effective,
          initialScope: location.scope,
        });
        const read = await resolveConfigRead({
          pluginName,
          plugin,
          scope: location.scope,
          projectLayer: location.projectLayer,
          cwd: context.cwd,
          env: context.env,
        });
        return { model, read, location };
      };
      if (item.plugin) return project(item.plugin.manifest.name, item.plugin);

      const inventory = await inventoryLegacyConfigReferences({ cwd: context.cwd, env: context.env });
      assertCatalogSourceReferencesSupported(inventory);
      const packageInfo = await readCliPackageInfo();
      return withResolvedCatalogPlugin({
        selector: item.pluginName,
        cliVersion: packageInfo.version,
        freshnessPolicy: 'cacheFirst',
        env: context.env,
        consume: ({ plugin }) => project(plugin.manifest.name, plugin),
      });
    },
    async saveConfig() {
      throw new Error('runtimeTransitionIncomplete: interactive config writes require the phase 3B namespaced runtime.');
    },
    async resetConfig() {
      throw new Error('runtimeTransitionIncomplete: interactive config writes require the phase 3B namespaced runtime.');
    },
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
  const progressFeed = createRebuildProgressFeed();
  const controller = createDashboardController(context, progressFeed);
  const sessionReporter: CommandReporter = {
    event: (event) => progressFeed.addEvent(event),
    notice: (notice) => progressFeed.addNotice(notice),
  };
  const result = await withCommandReporterSession(context.reporter, sessionReporter, () =>
    context.tuiRunner.launch<DashboardResult>({
      input: context.stdin,
      output: context.tuiOutput,
      render: (complete) => createElement(Dashboard, { controller, onComplete: complete }),
    }));
  return result.exitCode;
}
