#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Command, CommanderError } from 'commander';

import { initCommand } from './commands/init.js';
import {
  cleanupWriteCommand as cleanupCommand,
  installWriteCommand as installCommand,
  reinstallWriteCommand as reinstallCommand,
  uninstallWriteCommand as uninstallCommand,
  upgradeWriteCommand as upgradeCommand,
} from './commands/write-commands.js';
import {
  formatInteractiveConsoleUnavailableMessage,
  runConsoleController,
} from './commands/console.js';
import {
  createCliExecutionContext,
  emitCommandEvent,
  type CliExecutionContext,
  type CliExecutionContextInput,
  type CliIo,
  type CommandDiagnosticsInput,
} from './commands/runtime.js';
import { statusCommand } from './commands/status.js';
import {
  normalizeUninstallCommandOptions,
  normalizeCatalogSelectorOptions,
  normalizeCleanupCommandOptions,
  resolveConfigReadResolution,
  resolveConfigProjectLayer,
  resolveConfigWriteScope,
  applyCatalogSelectorEnv,
  normalizeInstallCommandOptions,
  normalizeReinstallCommandOptions,
  normalizeStatusCommandOptions,
  normalizeUpgradeCommandOptions,
} from './commands/options.js';
import {
  isCommandWarningError,
} from './types.js';
import { formatWarnings } from './output/reporter.js';
import {
  buildRebuildReceiptJson,
  buildInitFailureReceiptJson,
  buildInitReceiptJson,
  renderRebuildReceipt,
  renderInitReceipt,
  type CliCommandResult,
} from './output/command-receipt.js';
import { resolveCliPackageRoot } from './utils/paths.js';
import { isCatalogResolutionError, resolveCatalogPlugins } from './utils/plugin-catalog.js';
import {
  assertSafePluginConfigSegment,
  findConfigFieldEntry,
  hasConfigReadContent,
  readPluginConfigStore,
  renderPluginConfigValueForDisplay,
  resolveConfigRead,
} from './utils/plugin-config.js';
import {
  applyPluginConfigWrite,
  describeResetAffectedFields,
  resetPluginConfigWithHelper,
} from './utils/plugin-config-write.js';
import { assertStrictSemVer } from './utils/manifest.js';
import type { ConfigFieldEntry, PluginMeta, Scope } from './types.js';

export type { CliIo } from './commands/runtime.js';
export type CliRuntimeOptions = CliExecutionContextInput;

function createDefaultIo(): CliIo {
  return {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  };
}

function writeLine(write: (text: string) => void, line: string): void {
  write(`${line}\n`);
}

function writeWarnings(
  write: (text: string) => void,
  warnings: string[],
  options: { actionableOnly?: boolean } = {},
): void {
  for (const warning of formatWarnings(warnings, options)) {
    writeLine(write, warning);
  }
}

function resolveCliVersion(): string {
  const packageJsonPath = path.join(resolveCliPackageRoot(), 'package.json');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as {
    version?: unknown;
  };
  return assertStrictSemVer(packageJson.version, 'packages/cli/package.json version');
}

function resolveCommandReceiptExitCode(
  result: CliCommandResult,
): number {
  if (result.overallState === 'failed') {
    return 1;
  }
  return 0;
}

interface RawDiagnosticsOptions {
  verbose?: boolean;
  debug?: boolean;
  logFile?: string;
}

interface RawConfigOptions extends RawDiagnosticsOptions {
  scope?: string;
  catalogChannel?: string;
  catalogVersion?: string;
  json?: boolean;
  valueJson?: boolean;
  yes?: boolean;
  local?: boolean;
}

function toCliDiagnosticsOptions(
  commandName: string,
  rawOptions: RawDiagnosticsOptions,
  runtimeDiagnostics: CommandDiagnosticsInput | undefined,
): CommandDiagnosticsInput {
  return {
    ...runtimeDiagnostics,
    commandName,
    verbose: runtimeDiagnostics?.verbose === true || rawOptions.verbose === true,
    debug: runtimeDiagnostics?.debug === true || rawOptions.debug === true,
    logFile: rawOptions.logFile ?? runtimeDiagnostics?.logFile,
  };
}

function assertInstallPluginsProvided(pluginNames: string[]): void {
  if (pluginNames.length > 0) {
    return;
  }
  throw new Error(
    'install 命令至少需要一个插件名。运行 `aw` 打开交互控制台，或运行 `aw install <plugin>`。',
  );
}

function assertUninstallPluginsProvided(pluginNames: string[]): void {
  if (pluginNames.length > 0) {
    return;
  }
  throw new Error(
    'uninstall 命令至少需要一个插件名。运行 `aw` 打开交互控制台，或运行 `aw uninstall <plugin>`。',
  );
}

function assertUpgradeRequestProvided(pluginNames: string[], upgradeAll: boolean): void {
  if (pluginNames.length > 0 || upgradeAll) {
    return;
  }
  throw new Error(
    'upgrade 命令至少需要一个插件名，或传入 `--all`。运行 `aw` 打开交互控制台，或运行 `aw upgrade <plugin>` / `aw upgrade --all`。',
  );
}

function assertCleanupRequestProvided(pluginNames: string[]): void {
  if (pluginNames.length === 1) {
    return;
  }
  throw new Error('cleanup 命令当前只支持单个插件目标。');
}

function assertReinstallRequestProvided(pluginNames: string[]): void {
  if (pluginNames.length === 1) {
    return;
  }
  throw new Error('reinstall 命令当前只支持单个插件目标。');
}

function addCatalogSelectorOptions<T extends Command>(
  command: T,
  options: { includeChannelAlias?: boolean } = {},
): T {
  command
    .option('--catalog-channel <dist-tag>', 'use a specific current catalog dist-tag for this command')
    .option('--catalog-version <semver>', 'use a specific current catalog version for this command');
  if (options.includeChannelAlias) {
    command.option('--channel <dist-tag>', 'alias of --catalog-channel');
  }
  return command;
}

function parseBareConsoleOptions(
  argv: string[],
): (RawDiagnosticsOptions & { catalogChannel?: string; catalogVersion?: string }) | null {
  if (argv.length === 0) {
    return {};
  }

  const parsed: RawDiagnosticsOptions & { catalogChannel?: string; catalogVersion?: string } = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token) {
      continue;
    }
    if (token === '--help' || token === '-h' || token === '--version' || token === '-V') {
      return null;
    }
    if (token === '-v' || token === '--verbose') {
      parsed.verbose = true;
      continue;
    }
    if (token === '-D' || token === '--debug') {
      parsed.debug = true;
      continue;
    }
    if (token === '--log-file') {
      parsed.logFile = argv[index + 1];
      index += 1;
      continue;
    }
    if (token.startsWith('--log-file=')) {
      parsed.logFile = token.slice('--log-file='.length);
      continue;
    }
    if (token === '--catalog-channel') {
      parsed.catalogChannel = argv[index + 1];
      index += 1;
      continue;
    }
    if (token.startsWith('--catalog-channel=')) {
      parsed.catalogChannel = token.slice('--catalog-channel='.length);
      continue;
    }
    if (token === '--catalog-version') {
      parsed.catalogVersion = argv[index + 1];
      index += 1;
      continue;
    }
    if (token.startsWith('--catalog-version=')) {
      parsed.catalogVersion = token.slice('--catalog-version='.length);
      continue;
    }
    return null;
  }

  return parsed;
}

async function runActionWithContext<T>(
  context: CliExecutionContext,
  action: () => Promise<T>,
): Promise<T> {
  await emitCommandEvent(context, {
    type: 'command:start',
    data: {
      cwd: context.cwd,
      verbose: context.diagnostics.verbose,
      debug: context.diagnostics.debug,
      logFile: context.diagnostics.logFile,
    },
  });
  try {
    const result = await action();
    await emitCommandEvent(context, { type: 'command:success' });
    await context.debugLogger.flush?.();
    if (context.diagnostics.debug && context.debugLogger.logFile) {
      writeLine(context.io.stderr, `调试日志：${context.debugLogger.logFile}`);
    }
    return result;
  } catch (error) {
    await emitCommandEvent(context, {
      type: 'command:error',
      message: error instanceof Error ? error.message : String(error),
      data: error instanceof Error
        ? {
            name: error.name,
            stack: error.stack,
          }
        : undefined,
    });
    await context.debugLogger.flush?.();
    if (context.diagnostics.debug && context.debugLogger.logFile) {
      writeLine(context.io.stderr, `调试日志：${context.debugLogger.logFile}`);
    }
    throw error;
  }
}

async function loadConfigPluginLookup(
  pluginName: string,
  context: CliExecutionContext,
): Promise<{ plugin: PluginMeta | null; error: Error | null }> {
  assertSafePluginConfigSegment(pluginName);
  let plugins: Awaited<ReturnType<typeof resolveCatalogPlugins>>['plugins'];
  try {
    ({ plugins } = await resolveCatalogPlugins([pluginName], context.env));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === `Unknown plugin "${pluginName}".`) {
      return { plugin: null, error: null };
    }
    return {
      plugin: null,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
  return {
    plugin: plugins[0] ?? null,
    error: null,
  };
}

function writeJsonReceipt(write: (text: string) => void, payload: unknown): void {
  writeLine(write, JSON.stringify(payload, null, 2));
}

function configLayerLabel(scope: Scope, projectLayer: 'shared' | 'local' = 'shared'): string {
  if (scope === 'user') {
    return '个人';
  }
  return projectLayer === 'local' ? '当前项目（本机私有覆盖）' : '当前项目';
}

function writeConfigApplyNotice(
  write: (text: string) => void,
  receipt: {
    plugin: string;
    overallState: 'succeeded' | 'failed';
    targetResults: Array<{
      target: { platform: string; scope: Scope };
      state: string;
      message?: string;
    }>;
    applySkippedReason?: string;
    otherProjectsRequireReinstall: boolean;
  },
): void {
  if (receipt.targetResults.length === 0) {
    writeLine(write, receipt.applySkippedReason === 'noConfigChange'
      ? '配置内容没有变化，因此没有运行 reinstall。'
      : '配置已保存。当前没有可见的 AW 安装目标，因此没有应用配置。');
  } else {
    const completed = receipt.targetResults.filter((entry) => entry.state === 'completed').length;
    const failed = receipt.targetResults.filter((entry) => entry.state === 'failed');
    writeLine(write, `配置已保存。已重装 ${completed} 个当前可见目标；失败 ${failed.length} 个。`);
    for (const entry of failed) {
      writeLine(
        write,
        `${entry.target.platform}/${entry.target.scope}：${entry.message ?? 'reinstall 失败。'} `
        + `请重试 aw reinstall ${receipt.plugin} -p ${entry.target.platform} -s ${entry.target.scope}。`,
      );
    }
  }
  if (receipt.otherProjectsRequireReinstall) {
    writeLine(write, '其它项目没有被扫描。请进入每个项目目录并运行对应的 aw reinstall 命令。');
  }
}

function writeProjectLocalConfigNotice(write: (text: string) => void): void {
  writeLine(write, '当前显示的是当前项目的本机私有覆盖层，不作为 repo-visible artifact 渲染输入。');
}
function renderConfigFieldState(field: ConfigFieldEntry): string {
  if (field.valueState === 'invalid') {
    return 'invalid-config';
  }
  return field.valueState;
}

function writeConfigReadHuman(
  write: (text: string) => void,
  resolved: Awaited<ReturnType<typeof resolveConfigRead>>,
  pluginName: string,
): void {
  for (const field of resolved.fields) {
    const effectiveValue = field.effectiveValue === null
      ? '<unset>'
      : renderPluginConfigValueForDisplay(field.effectiveValue);
    const source = field.sourceLayer ?? 'none';
    writeLine(write, `${field.key}: ${renderConfigFieldState(field)} (source=${source}, effective=${effectiveValue})`);
    if (field.storedValue !== undefined && field.storedSourceLayer) {
      writeLine(
        write,
        `  stored=${field.storedSourceLayer} ${renderPluginConfigValueForDisplay(field.storedValue)}`,
      );
    }
    if (field.kind === 'manifest' && field.valueState === 'invalid') {
      const sourceScope = field.sourceLayer === 'project'
        ? ' -s project'
        : field.sourceLayer === 'local'
          ? ' -s project --local'
          : ' -s user';
      writeLine(write, `  aw config set ${pluginName} ${field.key} <value>${sourceScope}`);
      writeLine(write, `  aw config unset ${pluginName} ${field.key}${sourceScope}`);
      writeLine(write, `  aw config reset ${pluginName}${sourceScope}`);
    }
  }
}

export function buildProgram(options: CliRuntimeOptions = {}): Command {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const commandExitState = { exitCode: 0 };
  const io = {
    ...createDefaultIo(),
    ...options.io,
  };

  const createActionContext = (
    commandName: string,
    rawOptions: RawDiagnosticsOptions & {
      catalogChannel?: string;
      catalogVersion?: string;
      channel?: string;
    },
    selectorOptions: { allowChannelAlias?: boolean } = {},
  ): CliExecutionContext =>
    createCliExecutionContext({
      ...options,
      cwd,
      env: applyCatalogSelectorEnv(
        env,
        normalizeCatalogSelectorOptions(rawOptions, selectorOptions),
      ),
      io,
      interactive: options.interactive,
      diagnostics: toCliDiagnosticsOptions(commandName, rawOptions, options.diagnostics),
    });

  const program = new Command();
  program
    .name('aw')
    .description('Agent workflow marketplace installer')
    .version(resolveCliVersion(), '-V, --version', 'output the current aw cli version')
    .exitOverride()
    .configureOutput({
      writeOut: (text) => io.stdout(text),
      writeErr: (text) => io.stderr(text),
      outputError: (text, write) => write(text),
    });

  addCatalogSelectorOptions(
    program
      .command('init'),
    { includeChannelAlias: true },
  )
    .option('-f, --force', 're-fetch and rebuild the current catalog cache entry', false)
    .option('-j, --json', 'print receipt as JSON', false)
    .option('-v, --verbose', 'show command diagnostics', false)
    .option('-D, --debug', 'write debug diagnostics to a log file', false)
    .option('--log-file <path>', 'write debug diagnostics to the specified file')
    .action(async (rawOptions: {
      force?: boolean;
      json?: boolean;
      channel?: string;
      catalogChannel?: string;
      catalogVersion?: string;
    } & RawDiagnosticsOptions) => {
      const context = createActionContext('init', rawOptions, { allowChannelAlias: true });
      try {
        const result = await runActionWithContext(context, () =>
          initCommand({
            force: rawOptions.force,
            env: context.env,
            selectorOverrideSource: rawOptions.catalogVersion !== undefined
              ? 'option:catalog-version'
              : rawOptions.catalogChannel !== undefined
                ? 'option:catalog-channel'
                : rawOptions.channel !== undefined
                  ? 'option:channel-alias'
                  : undefined,
            ...normalizeCatalogSelectorOptions(rawOptions, { allowChannelAlias: true }),
          }),
        );
        if (rawOptions.json) {
          writeJsonReceipt(io.stdout, buildInitReceiptJson(result));
        } else {
          for (const line of renderInitReceipt(result)) {
            writeLine(io.stdout, line);
          }
        }
        writeWarnings(io.stderr, result.warnings, { actionableOnly: true });
      } catch (error) {
        if (rawOptions.json && isCatalogResolutionError(error)) {
          writeJsonReceipt(io.stdout, buildInitFailureReceiptJson(error.resolution));
          writeLine(io.stderr, error.message);
          commandExitState.exitCode = 1;
          return;
        }
        throw error;
      }
    });

  addCatalogSelectorOptions(
    program
      .command('install'),
  )
    .argument('[plugins...]')
    .option('-s, --scope <scope>', 'project or user')
    .option('-p, --platform <platform>', 'codex | claude | both')
    .option('--script-timeout <ms>', 'override plugin lifecycle script timeout in milliseconds')
    .option('-j, --json', 'print receipt as JSON', false)
    .option('-v, --verbose', 'show command diagnostics', false)
    .option('-D, --debug', 'write debug diagnostics to a log file', false)
    .option('--log-file <path>', 'write debug diagnostics to the specified file')
    .action(
      async (
        plugins: string[],
        rawOptions: {
          scope?: string;
          platform?: string;
          catalogChannel?: string;
          catalogVersion?: string;
          scriptTimeout?: string;
          json?: boolean;
        } & RawDiagnosticsOptions,
      ) => {
        const context = createActionContext('install', rawOptions);
        const receipt = await runActionWithContext(
          context,
          async () => {
            assertInstallPluginsProvided(plugins ?? []);
            const commandOptions = normalizeInstallCommandOptions({
              cwd,
              ...rawOptions,
            });
            await emitCommandEvent(context, {
              type: 'options:normalized',
              data: {
                plugins: plugins ?? [],
                options: commandOptions,
              },
            });
            const result = await installCommand(plugins ?? [], commandOptions, context);
            return {
              result,
              groups: [{
                scope: commandOptions.scope,
                platforms: result.platforms,
                plugins: result.plugins,
              }],
            };
          },
        );
        if (rawOptions.json) {
          writeJsonReceipt(io.stdout, buildRebuildReceiptJson('install', receipt.result));
        } else {
          for (const line of renderRebuildReceipt('install', receipt.result)) {
            writeLine(io.stdout, line);
          }
        }
        writeWarnings(io.stderr, receipt.result.warnings, { actionableOnly: true });
        commandExitState.exitCode = resolveCommandReceiptExitCode(receipt.result);
      },
    );

  program
    .command('uninstall')
    .argument('[plugins...]')
    .option('-s, --scope <scope>', 'project or user')
    .option('-p, --platform <platform>', 'codex | claude | both')
    .option('--script-timeout <ms>', 'override plugin lifecycle script timeout in milliseconds')
    .option('-j, --json', 'print receipt as JSON', false)
    .option('-v, --verbose', 'show command diagnostics', false)
    .option('-D, --debug', 'write debug diagnostics to a log file', false)
    .option('--log-file <path>', 'write debug diagnostics to the specified file')
    .action(async (
      plugins: string[],
      rawOptions: {
        scope?: string;
        platform?: string;
        scriptTimeout?: string;
        json?: boolean;
      } & RawDiagnosticsOptions,
    ) => {
      const context = createActionContext('uninstall', rawOptions);
      const receipt = await runActionWithContext(
        context,
        async () => {
          assertUninstallPluginsProvided(plugins ?? []);
          const commandOptions = normalizeUninstallCommandOptions({
            cwd,
            ...rawOptions,
          });
          await emitCommandEvent(context, {
            type: 'options:normalized',
            data: {
              plugins: plugins ?? [],
              options: commandOptions,
            },
          });
          const result = await uninstallCommand(plugins ?? [], commandOptions, context);
          return {
            result,
            groups: [{
              scope: commandOptions.scope,
              platforms: result.platforms,
              plugins: result.plugins,
            }],
          };
        },
      );
      if (rawOptions.json) {
        writeJsonReceipt(io.stdout, buildRebuildReceiptJson('uninstall', receipt.result));
      } else {
        for (const line of renderRebuildReceipt('uninstall', receipt.result)) {
          writeLine(io.stdout, line);
        }
      }
      writeWarnings(io.stderr, receipt.result.warnings, { actionableOnly: true });
      commandExitState.exitCode = resolveCommandReceiptExitCode(receipt.result);
    });

  addCatalogSelectorOptions(
    program
      .command('upgrade'),
  )
    .argument('[plugins...]')
    .option('-a, --all', 'upgrade all plugins', false)
    .option('-s, --scope <scope>', 'project or user')
    .option('-p, --platform <platform>', 'codex | claude | both')
    .option('--script-timeout <ms>', 'override plugin lifecycle script timeout in milliseconds')
    .option('-j, --json', 'print receipt as JSON', false)
    .option('-v, --verbose', 'show command diagnostics', false)
    .option('-D, --debug', 'write debug diagnostics to a log file', false)
    .option('--log-file <path>', 'write debug diagnostics to the specified file')
    .action(
      async (
        plugins: string[],
        rawOptions: {
          all?: boolean;
          scope?: string;
          platform?: string;
          catalogChannel?: string;
          catalogVersion?: string;
          scriptTimeout?: string;
          json?: boolean;
        } & RawDiagnosticsOptions,
      ) => {
        const context = createActionContext('upgrade', rawOptions);
        const receipt = await runActionWithContext(
          context,
          async () => {
            assertUpgradeRequestProvided(plugins ?? [], rawOptions.all === true);
            const commandOptions = normalizeUpgradeCommandOptions({
              cwd,
              ...rawOptions,
            });
            await emitCommandEvent(context, {
              type: 'options:normalized',
              data: {
                plugins: plugins ?? [],
                options: commandOptions,
              },
            });
            const result = await upgradeCommand(plugins ?? [], commandOptions, context);
            return {
              result,
              groups: [{
                scope: commandOptions.scope,
                platforms: result.platforms,
                plugins: result.plugins,
              }],
            };
          },
        );
        if (rawOptions.json) {
          writeJsonReceipt(io.stdout, buildRebuildReceiptJson('upgrade', receipt.result));
        } else {
          for (const line of renderRebuildReceipt('upgrade', receipt.result)) {
            writeLine(io.stdout, line);
          }
        }
        writeWarnings(io.stderr, receipt.result.warnings, { actionableOnly: true });
        commandExitState.exitCode = resolveCommandReceiptExitCode(receipt.result);
      },
    );

  program
    .command('cleanup')
    .argument('[plugins...]')
    .option('-s, --scope <scope>', 'project or user')
    .option('-p, --platform <platform>', 'codex | claude | both')
    .option('-j, --json', 'print cleanup result as JSON', false)
    .option('-v, --verbose', 'show command diagnostics', false)
    .option('-D, --debug', 'write debug diagnostics to a log file', false)
    .option('--log-file <path>', 'write debug diagnostics to the specified file')
    .action(async (
      plugins: string[],
      rawOptions: {
        scope?: string;
        platform?: string;
        json?: boolean;
      } & RawDiagnosticsOptions,
    ) => {
      const context = createActionContext('cleanup', rawOptions);
      const result = await runActionWithContext(
        context,
        async () => {
          const commandOptions = normalizeCleanupCommandOptions({
            cwd,
            ...rawOptions,
          });
          assertCleanupRequestProvided(plugins ?? []);
          await emitCommandEvent(context, {
            type: 'options:normalized',
            data: {
              plugins: plugins ?? [],
              options: commandOptions,
            },
          });
          return cleanupCommand(plugins ?? [], commandOptions, context);
        },
      );
      if (rawOptions.json) {
        writeJsonReceipt(io.stdout, buildRebuildReceiptJson('cleanup', result));
      } else {
        for (const line of renderRebuildReceipt('cleanup', result)) {
          writeLine(io.stdout, line);
        }
      }
      writeWarnings(io.stderr, result.warnings, { actionableOnly: true });
      commandExitState.exitCode = result.overallState === 'failed' ? 1 : 0;
    });

  addCatalogSelectorOptions(
    program
      .command('reinstall'),
  )
    .argument('[plugins...]')
    .option('-s, --scope <scope>', 'project or user')
    .option('-p, --platform <platform>', 'codex | claude | both')
    .option('--script-timeout <ms>', 'override plugin lifecycle script timeout in milliseconds')
    .option('-j, --json', 'print receipt as JSON', false)
    .option('-v, --verbose', 'show command diagnostics', false)
    .option('-D, --debug', 'write debug diagnostics to a log file', false)
    .option('--log-file <path>', 'write debug diagnostics to the specified file')
    .action(async (
      plugins: string[],
      rawOptions: {
        scope?: string;
        platform?: string;
        catalogChannel?: string;
        catalogVersion?: string;
        scriptTimeout?: string;
        json?: boolean;
      } & RawDiagnosticsOptions,
    ) => {
      const context = createActionContext('reinstall', rawOptions);
      const receipt = await runActionWithContext(
        context,
        async () => {
          const commandOptions = normalizeReinstallCommandOptions({
            cwd,
            ...rawOptions,
          });
          assertReinstallRequestProvided(plugins ?? []);
          await emitCommandEvent(context, {
            type: 'options:normalized',
            data: {
              plugins: plugins ?? [],
              options: commandOptions,
            },
          });
          const result = await reinstallCommand(plugins ?? [], commandOptions, context);
          return {
            result,
            groups: [{
              scope: commandOptions.scope,
              platforms: result.platforms,
              plugins: result.plugins,
            }],
          };
        },
      );
      if (rawOptions.json) {
        writeJsonReceipt(io.stdout, buildRebuildReceiptJson('reinstall', receipt.result));
      } else {
        const lines = renderRebuildReceipt('reinstall', receipt.result);
        for (const line of lines) {
          writeLine(io.stdout, line);
        }
      }
      writeWarnings(io.stderr, receipt.result.warnings, { actionableOnly: true });
      commandExitState.exitCode = resolveCommandReceiptExitCode(receipt.result);
    });

  const config = program
    .command('config')
    .description('Manage AW plugin configuration');

  config
    .command('list')
    .argument('<plugin>')
    .option('--catalog-channel <dist-tag>', 'use a specific current catalog dist-tag for this command')
    .option('--catalog-version <semver>', 'use a specific current catalog version for this command')
    .option('-s, --scope <scope>', 'read only project or user config')
    .option('--local', 'read only the current project local override layer', false)
    .option('-j, --json', 'print config as JSON', false)
    .option('-v, --verbose', 'show command diagnostics', false)
    .option('-D, --debug', 'write debug diagnostics to a log file', false)
    .option('--log-file <path>', 'write debug diagnostics to the specified file')
    .action(async (pluginName: string, rawOptions: RawConfigOptions) => {
      const context = createActionContext('config:list', rawOptions);
      const resolved = await runActionWithContext(context, async () => {
        const projectLayer = resolveConfigProjectLayer(rawOptions);
        const { plugin, error } = await loadConfigPluginLookup(pluginName, context);
        const result = await resolveConfigRead({
          pluginName,
          plugin,
          ...(error ? { pluginError: error } : {}),
          scope: rawOptions.local ? 'project' : resolveConfigReadResolution(rawOptions.scope),
          projectLayer,
          cwd: context.cwd,
          env: context.env,
        });
        if (!plugin && !hasConfigReadContent(result)) {
          throw new Error(
            `Unknown plugin "${pluginName}". Use \`aw config reset ${pluginName} -s user --yes\` or ` +
              `\`aw config reset ${pluginName} -s project --yes\` to clean leftover config stores.`,
          );
        }
        return result;
      });
      if (rawOptions.json) {
        writeJsonReceipt(io.stdout, {
          ok: true,
          configSchemaVersion: 3,
          command: 'config:list',
          plugin: pluginName,
          scope: rawOptions.local ? 'project' : rawOptions.scope ?? 'effective',
          projectLayer: rawOptions.local ? 'local' : 'shared',
          ...(resolved.schema ? { schema: resolved.schema } : {}),
          fields: resolved.fields,
        });
      } else {
        writeConfigReadHuman(io.stdout, resolved, pluginName);
      }
    });

  config
    .command('get')
    .argument('<plugin>')
    .argument('[key]')
    .option('--catalog-channel <dist-tag>', 'use a specific current catalog dist-tag for this command')
    .option('--catalog-version <semver>', 'use a specific current catalog version for this command')
    .option('-s, --scope <scope>', 'read only project or user config')
    .option('--local', 'read only the current project local override layer', false)
    .option('-j, --json', 'print config as JSON', false)
    .option('-v, --verbose', 'show command diagnostics', false)
    .option('-D, --debug', 'write debug diagnostics to a log file', false)
    .option('--log-file <path>', 'write debug diagnostics to the specified file')
    .action(async (pluginName: string, key: string | undefined, rawOptions: RawConfigOptions) => {
      const context = createActionContext('config:get', rawOptions);
      const resolved = await runActionWithContext(context, async () => {
        const projectLayer = resolveConfigProjectLayer(rawOptions);
        const { plugin, error } = await loadConfigPluginLookup(pluginName, context);
        const result = await resolveConfigRead({
          pluginName,
          plugin,
          ...(error ? { pluginError: error } : {}),
          scope: rawOptions.local ? 'project' : resolveConfigReadResolution(rawOptions.scope),
          projectLayer,
          cwd: context.cwd,
          env: context.env,
        });
        if (!plugin && !hasConfigReadContent(result)) {
          throw new Error(
            `Unknown plugin "${pluginName}". Use \`aw config reset ${pluginName} -s user --yes\` or ` +
              `\`aw config reset ${pluginName} -s project --yes\` to clean leftover config stores.`,
          );
        }
        if (!key) {
          return result;
        }
        const field = findConfigFieldEntry(result.fields, key);
        if (field) {
          return {
            ...result,
            fields: [field],
          };
        }

        if (plugin?.manifest.config?.schema?.[key] === undefined) {
          throw new Error(`Unknown config key "${key}".`);
        }
        return result;
      });
      if (rawOptions.json) {
        writeJsonReceipt(io.stdout, {
          ok: true,
          configSchemaVersion: 3,
          command: 'config:get',
          plugin: pluginName,
          key,
          scope: rawOptions.local ? 'project' : rawOptions.scope ?? 'effective',
          projectLayer: rawOptions.local ? 'local' : 'shared',
          ...(resolved.schema ? { schema: resolved.schema } : {}),
          fields: resolved.fields,
        });
      } else {
        writeConfigReadHuman(io.stdout, resolved, pluginName);
      }
    });

  config
    .command('set')
    .argument('<plugin>')
    .argument('<key>')
    .argument('<value>')
    .option('--catalog-channel <dist-tag>', 'use a specific current catalog dist-tag for this command')
    .option('--catalog-version <semver>', 'use a specific current catalog version for this command')
    .option('-s, --scope <scope>', 'project or user')
    .option('--local', 'write only the current project local override layer', false)
    .option('--value-json', 'parse value as a JSON literal', false)
    .option('-j, --json', 'print receipt as JSON', false)
    .option('-v, --verbose', 'show command diagnostics', false)
    .option('-D, --debug', 'write debug diagnostics to a log file', false)
    .option('--log-file <path>', 'write debug diagnostics to the specified file')
    .action(async (
      pluginName: string,
      key: string,
      rawValue: string,
      rawOptions: RawConfigOptions,
    ) => {
      const context = createActionContext('config:set', rawOptions);
      const receipt = await runActionWithContext(context, async () => {
        const scope = resolveConfigWriteScope(rawOptions.scope);
        const projectLayer = resolveConfigProjectLayer(rawOptions);
        const { plugin, error } = await loadConfigPluginLookup(pluginName, context);
        const inputValue = rawOptions.valueJson ? JSON.parse(rawValue) : rawValue;
        const writeReceipt = await applyPluginConfigWrite({
          plugin,
          ...(error ? { pluginError: error } : {}),
          pluginName,
          scope,
          projectLayer,
          cwd: context.cwd,
          env: context.env,
          nativeCliRunner: context.nativeCliRunner,
          catalogChannel: rawOptions.catalogChannel,
          catalogVersion: rawOptions.catalogVersion,
          request: {
            updates: { [key]: inputValue },
          },
        });
        return {
          ok: writeReceipt.overallState === 'succeeded',
          receiptSchemaVersion: 3,
          command: 'config:set',
          ...writeReceipt,
          affectedFields: [{
            key,
            title: plugin?.manifest.config?.schema?.[key]?.title ?? key,
            kind: 'manifest' as const,
            reserved: false,
            action: 'set' as const,
            scope,
            ...(scope === 'project' ? { projectLayer } : {}),
          }],
        };
      });
      if (rawOptions.json) {
        writeJsonReceipt(io.stdout, receipt);
      } else {
        writeLine(io.stdout, `已写入 ${receipt.plugin}.${key}（${configLayerLabel(receipt.scope, receipt.projectLayer)}配置）。`);
        if (receipt.projectLayer === 'local') {
          writeProjectLocalConfigNotice(io.stdout);
        }
        writeConfigApplyNotice(io.stderr, receipt);
      }
      commandExitState.exitCode = receipt.overallState === 'failed' ? 1 : 0;
    });

  config
    .command('unset')
    .argument('<plugin>')
    .argument('<key>')
    .option('--catalog-channel <dist-tag>', 'use a specific current catalog dist-tag for this command')
    .option('--catalog-version <semver>', 'use a specific current catalog version for this command')
    .option('-s, --scope <scope>', 'project or user')
    .option('--local', 'write only the current project local override layer', false)
    .option('-j, --json', 'print receipt as JSON', false)
    .option('-v, --verbose', 'show command diagnostics', false)
    .option('-D, --debug', 'write debug diagnostics to a log file', false)
    .option('--log-file <path>', 'write debug diagnostics to the specified file')
    .action(async (pluginName: string, key: string, rawOptions: RawConfigOptions) => {
      const context = createActionContext('config:unset', rawOptions);
      const receipt = await runActionWithContext(context, async () => {
        const scope = resolveConfigWriteScope(rawOptions.scope);
        const projectLayer = resolveConfigProjectLayer(rawOptions);
        const { plugin, error } = await loadConfigPluginLookup(pluginName, context);
        if (plugin && !plugin.manifest.config?.schema?.[key]) {
          throw new Error(`Unknown config key "${key}".`);
        }
        const store = await readPluginConfigStore({
          pluginName,
          scope,
          ...(scope === 'project' ? { projectLayer } : {}),
          cwd: context.cwd,
          env: context.env,
        });
        const existed = Object.hasOwn(store.values, key);
        const writeReceipt = await applyPluginConfigWrite({
          plugin,
          ...(error ? { pluginError: error } : {}),
          pluginName,
          scope,
          projectLayer,
          cwd: context.cwd,
          env: context.env,
          nativeCliRunner: context.nativeCliRunner,
          catalogChannel: rawOptions.catalogChannel,
          catalogVersion: rawOptions.catalogVersion,
          request: {
            removeKeys: [key],
          },
        });
        return {
          ok: writeReceipt.overallState === 'succeeded',
          receiptSchemaVersion: 3,
          command: 'config:unset',
          ...writeReceipt,
          removedKey: key,
          existed,
          affectedFields: [{
            key,
            title: plugin?.manifest.config?.schema?.[key]?.title ?? key,
            kind: 'manifest' as const,
            reserved: false,
            action: 'unset' as const,
            scope,
            ...(scope === 'project' ? { projectLayer } : {}),
          }],
        };
      });
      if (rawOptions.json) {
        writeJsonReceipt(io.stdout, receipt);
      } else {
        writeLine(io.stdout, receipt.existed
          ? `已删除 ${receipt.plugin}.${receipt.removedKey}（${configLayerLabel(receipt.scope, receipt.projectLayer)}配置）。`
          : `${receipt.plugin}.${receipt.removedKey}（${configLayerLabel(receipt.scope, receipt.projectLayer)}配置）原本不存在。`);
        if (receipt.projectLayer === 'local') {
          writeProjectLocalConfigNotice(io.stdout);
        }
        writeConfigApplyNotice(io.stderr, receipt);
      }
      commandExitState.exitCode = receipt.overallState === 'failed' ? 1 : 0;
    });

  config
    .command('reset')
    .argument('<plugin>')
    .option('-s, --scope <scope>', 'project or user')
    .option('--local', 'reset only the current project local override layer', false)
    .option('-y, --yes', 'confirm destructive reset', false)
    .option('-j, --json', 'print receipt as JSON', false)
    .option('-v, --verbose', 'show command diagnostics', false)
    .option('-D, --debug', 'write debug diagnostics to a log file', false)
    .option('--log-file <path>', 'write debug diagnostics to the specified file')
    .action(async (pluginName: string, rawOptions: RawConfigOptions) => {
      const context = createActionContext('config:reset', rawOptions);
      const receipt = await runActionWithContext(context, async () => {
        assertSafePluginConfigSegment(pluginName);
        const scope = resolveConfigWriteScope(rawOptions.scope);
        const projectLayer = resolveConfigProjectLayer(rawOptions);
        const store = await readPluginConfigStore({
          pluginName,
          scope,
          ...(scope === 'project' ? { projectLayer } : {}),
          cwd: context.cwd,
          env: context.env,
        });
        if (store.exists && !rawOptions.yes) {
          throw new Error(
            `Reset requires confirmation. Re-run \`aw config reset ${pluginName} -s ${scope}${projectLayer === 'local' ? ' --local' : ''} --yes\` to delete this store.`,
          );
        }
        const { plugin, error } = await loadConfigPluginLookup(pluginName, context);
        const affectedFields = await describeResetAffectedFields({
          pluginName,
          ...(plugin ? { plugin } : {}),
          ...(error ? { pluginError: error } : {}),
          scope,
          projectLayer,
          cwd: context.cwd,
          env: context.env,
        });
        const resetReceipt = await resetPluginConfigWithHelper({
          pluginName,
          scope,
          projectLayer,
          cwd: context.cwd,
          env: context.env,
          nativeCliRunner: context.nativeCliRunner,
          catalogChannel: rawOptions.catalogChannel,
          catalogVersion: rawOptions.catalogVersion,
          ...(error ? { pluginError: error } : {}),
          ...(plugin ? { plugin } : {}),
        });
        return {
          ok: resetReceipt.overallState === 'succeeded',
          receiptSchemaVersion: 3,
          command: 'config:reset',
          ...resetReceipt,
          affectedFields,
        };
      });
      if (rawOptions.json) {
        writeJsonReceipt(io.stdout, receipt);
      } else {
        writeLine(io.stdout, receipt.deleted
          ? `已重置 ${receipt.plugin} 的${configLayerLabel(receipt.scope, receipt.projectLayer)}配置。`
          : `${receipt.plugin} 没有可重置的${configLayerLabel(receipt.scope, receipt.projectLayer)}配置。`);
        if (receipt.projectLayer === 'local') {
          writeProjectLocalConfigNotice(io.stdout);
        }
        writeConfigApplyNotice(io.stderr, receipt);
      }
      commandExitState.exitCode = receipt.overallState === 'failed' ? 1 : 0;
    });

  addCatalogSelectorOptions(
    program
      .command('status'),
  )
    .argument('[plugins...]')
    .option('-s, --scope <scope>', 'filter by scope')
    .option('-p, --platform <platform>', 'filter by platform')
    .option('-v, --verbose', 'show status details and command diagnostics', false)
    .option('-D, --debug', 'write debug diagnostics to a log file', false)
    .option('--log-file <path>', 'write debug diagnostics to the specified file')
    .option('-j, --json', 'print status as JSON', false)
    .action(async (
      plugins: string[],
      rawOptions: {
        scope?: string;
        platform?: string;
        catalogChannel?: string;
        catalogVersion?: string;
        json?: boolean;
      } & RawDiagnosticsOptions,
    ) => {
      const context = createActionContext('status', rawOptions);
      const result = await runActionWithContext(
        context,
        () => statusCommand(
          plugins ?? [],
          normalizeStatusCommandOptions({
            cwd,
            ...rawOptions,
          }),
          context,
        ),
      );
      commandExitState.exitCode = result.hasErrors ? 1 : 0;
      writeLine(io.stdout, result.output);
    });

  Object.assign(program, { __awCommandExitState: commandExitState });
  return program;
}

function handleCliError(
  error: unknown,
  writeError: (text: string) => void,
): number {
  if (error instanceof CommanderError) {
    return error.exitCode;
  }

  if (isCommandWarningError(error)) {
    writeWarnings(writeError, error.warnings);
    writeLine(writeError, error.message);
    return error.exitCode;
  }

  writeLine(writeError, error instanceof Error ? error.message : String(error));
  return 1;
}

export async function runCli(
  argv: string[],
  options: CliRuntimeOptions = {},
): Promise<number> {
  const io = {
    ...createDefaultIo(),
    ...options.io,
  };

  try {
    const bareConsoleOptions = parseBareConsoleOptions(argv);
    if (bareConsoleOptions) {
      const context = createCliExecutionContext({
        ...options,
        io,
        env: applyCatalogSelectorEnv(
          options.env ?? process.env,
          normalizeCatalogSelectorOptions(bareConsoleOptions),
        ),
        diagnostics: {
          ...options.diagnostics,
          commandName: 'console',
          metadata: {
            ...options.diagnostics?.metadata,
            rawArgv: argv,
          },
        },
      });
      if (!context.interactive) {
        writeLine(io.stderr, formatInteractiveConsoleUnavailableMessage(context));
        return 1;
      }
      return await runActionWithContext(context, () => runConsoleController(context));
    }
    const program = buildProgram({
      ...options,
      io,
      diagnostics: {
        ...options.diagnostics,
        metadata: {
          ...options.diagnostics?.metadata,
          rawArgv: argv,
        },
      },
    });
    await program.parseAsync(['node', 'aw', ...argv]);
    return (program as Command & {
      __awCommandExitState?: { exitCode: number };
    }).__awCommandExitState?.exitCode ?? 0;
  } catch (error) {
    return handleCliError(error, io.stderr);
  }
}

export async function main(
  argv = process.argv.slice(2),
  options: CliRuntimeOptions = {},
): Promise<number> {
  return runCli(argv, options);
}

const currentEntryPath = fileURLToPath(import.meta.url);
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;

if (invokedPath === currentEntryPath) {
  void main().then((exitCode) => {
    if (exitCode !== 0) {
      process.exitCode = exitCode;
    }
  });
}
