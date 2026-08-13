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
import type { RebuildCommandResult } from './commands/rebuild-command.js';
import {
  dashboardActions,
  formatInteractiveConsoleUnavailableMessage,
  runConsoleController,
} from './commands/console.js';
import {
  runCommandWizard,
  toWizardCandidates,
  type CommandWizardCommand,
  type CommandWizardPluginCandidate,
  type CommandWizardSelection,
} from './commands/wizard.js';
import {
  createCliExecutionContext,
  emitCommandEvent,
  type CliExecutionContext,
  type CliExecutionContextInput,
  type CliIo,
  type CommandDiagnosticsInput,
} from './commands/runtime.js';
import { loadConsoleItemsResult, statusCommand } from './commands/status.js';
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
  coercePluginConfigUpdates,
  findConfigFieldEntry,
  hasConfigReadContent,
  listPluginConfigStorePluginNames,
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
import {
  formatConfigCommandValue,
  parseConfigValue,
} from './utils/config-value.js';
import type {
  ConfigFieldEntry,
  PlatformSelection,
  PluginMeta,
  Scope,
} from './types.js';

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

type WriteWizardCommand = Extract<
  CommandWizardCommand,
  'install' | 'upgrade' | 'reinstall' | 'uninstall' | 'cleanup'
>;

function isWizardAvailable(
  context: CliExecutionContext,
  rawOptions: { json?: boolean },
): boolean {
  return context.interactive && context.isTty && !context.isCi && rawOptions.json !== true;
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:@+-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", `'"'"'`)}'`;
}

function shellCommand(tokens: string[]): string {
  return tokens.map(shellQuote).join(' ');
}

function optionTokens(flag: string, value: string | undefined): string[] {
  return value === undefined ? [] : [flag, value];
}

function catalogSelectorTokens(rawOptions: {
  catalogChannel?: string;
  catalogVersion?: string;
}): string[] {
  return [
    ...optionTokens('--catalog-channel', rawOptions.catalogChannel),
    ...optionTokens('--catalog-version', rawOptions.catalogVersion),
  ];
}

function writeCommandUsage(command: WriteWizardCommand): string {
  const cardinality = command === 'reinstall' || command === 'cleanup' ? '<plugin>' : '<plugin...>';
  const scope = command === 'cleanup' ? ' --scope <project|user>' : ' [--scope <project|user>]';
  const all = command === 'upgrade' ? ' 或 aw upgrade --all --platform both --scope user' : '';
  return [
    `${command} 命令缺少必要参数。`,
    `Usage: aw ${command} ${cardinality} --platform <codex|claude|both>${scope}`,
    `Example: aw ${command} example-plugin --platform codex --scope user${all}`,
  ].join('\n');
}

function configCommandUsage(command: 'list' | 'get' | 'set' | 'unset' | 'reset'): string {
  const argumentsByCommand = {
    list: '<plugin>',
    get: '<plugin> [key]',
    set: '<plugin> <key> <value>',
    unset: '<plugin> <key>',
    reset: '<plugin> --scope <project|user> --yes',
  } as const;
  return [
    `config ${command} 命令缺少必要参数。`,
    `Usage: aw config ${command} ${argumentsByCommand[command]}`,
    `Example: aw config ${command} example-plugin${command === 'set' ? ' key value' : command === 'unset' ? ' key' : command === 'reset' ? ' --scope user --yes' : ''}`,
  ].join('\n');
}

function assertUpgradeAllConflict(pluginNames: string[], all: boolean): void {
  if (all && pluginNames.length > 0) {
    throw new Error('upgrade 命令不能同时使用插件名和 `--all`。');
  }
}

function equivalentWriteCommand(
  command: WriteWizardCommand,
  selection: CommandWizardSelection,
  rawOptions: RawWriteWizardOptions,
): string {
  return shellCommand(buildEquivalentWriteCommandTokens(command, selection, rawOptions));
}

export function buildEquivalentWriteCommandTokens(
  command: WriteWizardCommand,
  selection: CommandWizardSelection,
  rawOptions: RawWriteWizardOptions,
): string[] {
  const all = command === 'upgrade' && rawOptions.all === true;
  return [
    'aw',
    command,
    ...(all ? ['--all'] : []),
    '--platform',
    selection.platform ?? 'both',
    '--scope',
    selection.scope ?? 'user',
    ...(command === 'install' || command === 'upgrade' || command === 'reinstall'
      ? catalogSelectorTokens(rawOptions)
      : []),
    ...(command === 'cleanup' ? [] : optionTokens('--script-timeout', rawOptions.scriptTimeout)),
    ...(!all && selection.plugins.length > 0 ? ['--', ...selection.plugins] : []),
  ];
}

interface EquivalentConfigCommandOptions {
  command: 'list' | 'get' | 'set' | 'unset' | 'reset';
  plugin: string;
  key?: string;
  value?: string;
  scope?: string;
  projectLayer?: 'shared' | 'local';
  valueJson?: boolean;
  confirmed?: boolean;
  catalogChannel?: string;
  catalogVersion?: string;
}

function equivalentConfigCommand(options: EquivalentConfigCommandOptions): string {
  return shellCommand(buildEquivalentConfigCommandTokens(options));
}

export function buildEquivalentConfigCommandTokens(
  options: EquivalentConfigCommandOptions,
): string[] {
  return [
    'aw',
    'config',
    options.command,
    ...optionTokens('--scope', options.scope),
    ...(options.projectLayer === 'local' ? ['--local'] : []),
    ...(options.valueJson ? ['--value-json'] : []),
    ...(options.command === 'reset' ? [] : catalogSelectorTokens(options)),
    ...(options.confirmed ? ['--yes'] : []),
    '--',
    options.plugin,
    ...(options.key === undefined ? [] : [options.key]),
    ...(options.value === undefined ? [] : [options.value]),
  ];
}

function writeCandidateEligibility(
  command: WriteWizardCommand,
  candidate: CommandWizardPluginCandidate,
  selection: CommandWizardSelection,
): { selectable: boolean; reason?: string } {
  const targets = candidate.targets.filter((target) =>
    target.target.scope === (selection.scope ?? 'user')
    && (selection.platform === 'both' || target.target.platform === selection.platform));
  if (targets.length === 0) {
    return { selectable: false, reason: 'current bundle 不支持所选平台和范围' };
  }
  const selectable = targets.every((target) => dashboardActions({
    pluginName: candidate.pluginName,
    targets: candidate.targets,
  }, target).includes(command));
  return selectable
    ? { selectable: true }
    : { selectable: false, reason: `live status 不允许 ${command}` };
}

async function loadWizardCandidates(
  context: CliExecutionContext,
  rawOptions: { scope?: string; platform?: string },
): Promise<CommandWizardPluginCandidate[]> {
  const loaded = await loadConsoleItemsResult({
    cwd: context.cwd,
    scope: rawOptions.scope as Scope | undefined,
    platform: rawOptions.platform as PlatformSelection | undefined,
    includeCatalogOnly: true,
  }, context);
  return toWizardCandidates(loaded.items);
}

interface ConfigWizardStoreLocation {
  scope: Scope;
  projectLayer: 'shared' | 'local';
}

function mergeWizardCandidates(
  current: CommandWizardPluginCandidate[],
  stored: CommandWizardPluginCandidate[],
): CommandWizardPluginCandidate[] {
  const merged = new Map(current.map((candidate) => [candidate.pluginName, candidate]));
  for (const candidate of stored) {
    const existing = merged.get(candidate.pluginName);
    if (!existing) {
      merged.set(candidate.pluginName, candidate);
    } else if (!existing.configSchema) {
      merged.set(candidate.pluginName, { ...candidate, ...existing });
    }
  }
  return [...merged.values()];
}

async function loadStoredConfigWizardCandidates(
  context: CliExecutionContext,
  locations: ConfigWizardStoreLocation[],
  options: { includeEmptyStores?: boolean } = {},
): Promise<CommandWizardPluginCandidate[]> {
  const keysByPlugin = new Map<string, Set<string>>();
  for (const location of locations) {
    const pluginNames = await listPluginConfigStorePluginNames({
      cwd: context.cwd,
      env: context.env,
      scope: location.scope,
      ...(location.scope === 'project' ? { projectLayer: location.projectLayer } : {}),
    });
    for (const pluginName of pluginNames) {
      const store = await readPluginConfigStore({
        pluginName,
        scope: location.scope,
        ...(location.scope === 'project' ? { projectLayer: location.projectLayer } : {}),
        cwd: context.cwd,
        env: context.env,
      });
      const keys = Object.keys(store.values);
      if (!store.exists || (keys.length === 0 && options.includeEmptyStores !== true)) continue;
      const existing = keysByPlugin.get(pluginName) ?? new Set<string>();
      for (const key of keys) existing.add(key);
      keysByPlugin.set(pluginName, existing);
    }
  }
  return [...keysByPlugin]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([pluginName, keys]) => ({
      pluginName,
      targets: [],
      configKeys: [...keys].sort((left, right) => left.localeCompare(right)),
    }));
}

function configReadStoreLocations(rawOptions: RawConfigOptions): ConfigWizardStoreLocation[] {
  if (rawOptions.local) return [{ scope: 'project', projectLayer: 'local' }];
  if (rawOptions.scope === 'user') return [{ scope: 'user', projectLayer: 'shared' }];
  if (rawOptions.scope === 'project') return [{ scope: 'project', projectLayer: 'shared' }];
  return [
    { scope: 'user', projectLayer: 'shared' },
    { scope: 'project', projectLayer: 'shared' },
    { scope: 'project', projectLayer: 'local' },
  ];
}

function overallResultState(value: { overallState: 'succeeded' | 'failed' }): 'succeeded' | 'failed' {
  return value.overallState;
}

interface RawWriteWizardOptions extends RawDiagnosticsOptions {
  all?: boolean;
  scope?: string;
  platform?: string;
  catalogChannel?: string;
  catalogVersion?: string;
  scriptTimeout?: string;
  json?: boolean;
}

async function executeWriteCommand(
  command: WriteWizardCommand,
  pluginNames: string[],
  rawOptions: RawWriteWizardOptions,
  context: CliExecutionContext,
): Promise<RebuildCommandResult> {
  const raw = { cwd: context.cwd, ...rawOptions };
  const commandOptions = command === 'install'
    ? normalizeInstallCommandOptions(raw)
    : command === 'upgrade'
      ? normalizeUpgradeCommandOptions(raw)
      : command === 'uninstall'
        ? normalizeUninstallCommandOptions(raw)
        : command === 'cleanup'
          ? normalizeCleanupCommandOptions(raw)
          : normalizeReinstallCommandOptions(raw);
  await emitCommandEvent(context, {
    type: 'options:normalized',
    data: { plugins: pluginNames, options: commandOptions },
  });
  switch (command) {
    case 'install': return installCommand(pluginNames, commandOptions, context);
    case 'upgrade': return upgradeCommand(pluginNames, commandOptions, context);
    case 'uninstall': return uninstallCommand(pluginNames, commandOptions, context);
    case 'cleanup': return cleanupCommand(pluginNames, commandOptions, context);
    case 'reinstall': return reinstallCommand(pluginNames, commandOptions, context);
  }
}

async function runWriteCommandAction(
  command: WriteWizardCommand,
  pluginNames: string[],
  rawOptions: RawWriteWizardOptions,
  context: CliExecutionContext,
): Promise<{ cancelled: true } | { cancelled: false; result: RebuildCommandResult }> {
  if ((command === 'cleanup' || command === 'reinstall') && pluginNames.length > 1) {
    throw new Error(`${command} 命令当前只支持单个插件目标。`);
  }
  if (command === 'upgrade') assertUpgradeAllConflict(pluginNames, rawOptions.all === true);

  const missingPlugin = pluginNames.length === 0 && !(command === 'upgrade' && rawOptions.all === true);
  const missingPlatform = rawOptions.platform === undefined;
  const missingScope = command === 'cleanup' && rawOptions.scope === undefined;
  const missing = missingPlugin || missingPlatform || missingScope;

  // Validate every value already supplied by the caller before opening the TUI.
  const validationOptions = {
    cwd: context.cwd,
    ...rawOptions,
    platform: rawOptions.platform ?? 'both',
    ...(command === 'cleanup' ? { scope: rawOptions.scope ?? 'user' } : {}),
  };
  if (command === 'install') normalizeInstallCommandOptions(validationOptions);
  else if (command === 'upgrade') normalizeUpgradeCommandOptions(validationOptions);
  else if (command === 'uninstall') normalizeUninstallCommandOptions(validationOptions);
  else if (command === 'cleanup') normalizeCleanupCommandOptions(validationOptions);
  else normalizeReinstallCommandOptions(validationOptions);

  if (!missing) {
    return {
      cancelled: false,
      result: await executeWriteCommand(command, pluginNames, rawOptions, context),
    };
  }
  if (!isWizardAvailable(context, rawOptions)) {
    throw new Error(writeCommandUsage(command));
  }

  const candidates = missingPlugin ? await loadWizardCandidates(context, {
    scope: rawOptions.scope,
    platform: rawOptions.platform,
  }) : [];
  const result = await runCommandWizard(context, {
    command,
    candidates,
    initial: {
      plugins: pluginNames,
      platform: rawOptions.platform as PlatformSelection | undefined,
      scope: (rawOptions.scope ?? 'user') as Scope,
    },
    pluginMode: missingPlugin
      ? command === 'cleanup' || command === 'reinstall' ? 'single' : 'multiple'
      : 'none',
    promptForPlatform: missingPlatform,
    promptForScope: missingScope,
    destructive: command === 'uninstall' || command === 'cleanup',
    equivalentCommand: (selection) => equivalentWriteCommand(
      command,
      selection,
      rawOptions,
    ),
    isPluginSelectable: (candidate, selection) =>
      writeCandidateEligibility(command, candidate, selection),
    resultState: overallResultState,
    execute: (selection) => executeWriteCommand(command, selection.plugins, {
      ...rawOptions,
      platform: selection.platform,
      scope: selection.scope,
    }, context),
  });
  if (result.cancelled) return { cancelled: true };
  return { cancelled: false, result: result.value! };
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
    const message = receipt.applySkippedReason === 'noConfigChange'
      ? '配置内容没有变化，因此没有运行 reinstall。'
      : receipt.applySkippedReason === 'currentCatalogUnavailable'
        ? '配置已保存。当前插件或 config schema 不可定位，因此没有运行 reinstall。'
        : '配置已保存。当前没有可见的 AW 安装目标，因此没有应用配置。';
    writeLine(write, message);
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
        const outcome = await runActionWithContext(context, () =>
          runWriteCommandAction('install', plugins ?? [], rawOptions, context));
        if (outcome.cancelled) return;
        const receipt = outcome.result;
        if (rawOptions.json) {
          writeJsonReceipt(io.stdout, buildRebuildReceiptJson('install', receipt));
        } else {
          for (const line of renderRebuildReceipt('install', receipt)) {
            writeLine(io.stdout, line);
          }
        }
        writeWarnings(io.stderr, receipt.warnings, { actionableOnly: true });
        commandExitState.exitCode = resolveCommandReceiptExitCode(receipt);
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
      const outcome = await runActionWithContext(context, () =>
        runWriteCommandAction('uninstall', plugins ?? [], rawOptions, context));
      if (outcome.cancelled) return;
      const receipt = outcome.result;
      if (rawOptions.json) {
        writeJsonReceipt(io.stdout, buildRebuildReceiptJson('uninstall', receipt));
      } else {
        for (const line of renderRebuildReceipt('uninstall', receipt)) {
          writeLine(io.stdout, line);
        }
      }
      writeWarnings(io.stderr, receipt.warnings, { actionableOnly: true });
      commandExitState.exitCode = resolveCommandReceiptExitCode(receipt);
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
        const outcome = await runActionWithContext(context, () =>
          runWriteCommandAction('upgrade', plugins ?? [], rawOptions, context));
        if (outcome.cancelled) return;
        const receipt = outcome.result;
        if (rawOptions.json) {
          writeJsonReceipt(io.stdout, buildRebuildReceiptJson('upgrade', receipt));
        } else {
          for (const line of renderRebuildReceipt('upgrade', receipt)) {
            writeLine(io.stdout, line);
          }
        }
        writeWarnings(io.stderr, receipt.warnings, { actionableOnly: true });
        commandExitState.exitCode = resolveCommandReceiptExitCode(receipt);
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
      const outcome = await runActionWithContext(context, () =>
        runWriteCommandAction('cleanup', plugins ?? [], rawOptions, context));
      if (outcome.cancelled) return;
      const result = outcome.result;
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
      const outcome = await runActionWithContext(context, () =>
        runWriteCommandAction('reinstall', plugins ?? [], rawOptions, context));
      if (outcome.cancelled) return;
      const receipt = outcome.result;
      if (rawOptions.json) {
        writeJsonReceipt(io.stdout, buildRebuildReceiptJson('reinstall', receipt));
      } else {
        const lines = renderRebuildReceipt('reinstall', receipt);
        for (const line of lines) {
          writeLine(io.stdout, line);
        }
      }
      writeWarnings(io.stderr, receipt.warnings, { actionableOnly: true });
      commandExitState.exitCode = resolveCommandReceiptExitCode(receipt);
    });

  const config = program
    .command('config')
    .description('Manage AW plugin configuration');

  config
    .command('list')
    .argument('[plugin]')
    .option('--catalog-channel <dist-tag>', 'use a specific current catalog dist-tag for this command')
    .option('--catalog-version <semver>', 'use a specific current catalog version for this command')
    .option('-s, --scope <scope>', 'read only project or user config')
    .option('--local', 'read only the current project local override layer', false)
    .option('-j, --json', 'print config as JSON', false)
    .option('-v, --verbose', 'show command diagnostics', false)
    .option('-D, --debug', 'write debug diagnostics to a log file', false)
    .option('--log-file <path>', 'write debug diagnostics to the specified file')
    .action(async (pluginName: string | undefined, rawOptions: RawConfigOptions) => {
      const context = createActionContext('config:list', rawOptions);
      const outcome = await runActionWithContext(context, async () => {
        resolveConfigProjectLayer(rawOptions);
        if (!rawOptions.local) resolveConfigReadResolution(rawOptions.scope);
        const execute = async (selectedPlugin: string) => {
        const projectLayer = resolveConfigProjectLayer(rawOptions);
        const { plugin, error } = await loadConfigPluginLookup(selectedPlugin, context);
        const result = await resolveConfigRead({
          pluginName: selectedPlugin,
          plugin,
          ...(error ? { pluginError: error } : {}),
          scope: rawOptions.local ? 'project' : resolveConfigReadResolution(rawOptions.scope),
          projectLayer,
          cwd: context.cwd,
          env: context.env,
        });
        if (!plugin && !hasConfigReadContent(result)) {
          throw new Error(
            `Unknown plugin "${selectedPlugin}". Use \`aw config reset ${selectedPlugin} -s user --yes\` or ` +
              `\`aw config reset ${selectedPlugin} -s project --yes\` to clean leftover config stores.`,
          );
        }
        return result;
        };
        if (pluginName) return { cancelled: false as const, pluginName, value: await execute(pluginName) };
        if (!isWizardAvailable(context, rawOptions)) throw new Error(configCommandUsage('list'));
        const currentCandidates = await loadWizardCandidates(context, {});
        const storedCandidates = await loadStoredConfigWizardCandidates(
          context,
          configReadStoreLocations(rawOptions),
        );
        const candidates = mergeWizardCandidates(currentCandidates, storedCandidates);
        if (candidates.length === 0) {
          throw new Error('No plugin config candidates exist in the selected location.');
        }
        const result = await runCommandWizard(context, {
          command: 'config:list',
          candidates,
          initial: { plugins: [], scope: rawOptions.scope as Scope | undefined },
          pluginMode: 'single',
          equivalentCommand: (selection) => equivalentConfigCommand({
            command: 'list',
            plugin: selection.plugins[0]!,
            scope: rawOptions.scope,
            projectLayer: rawOptions.local ? 'local' : 'shared',
            catalogChannel: rawOptions.catalogChannel,
            catalogVersion: rawOptions.catalogVersion,
          }),
          execute: (selection) => execute(selection.plugins[0]!),
        });
        return result.cancelled
          ? { cancelled: true as const }
          : { cancelled: false as const, pluginName: result.selection!.plugins[0]!, value: result.value! };
      });
      if (outcome.cancelled) return;
      const resolved = outcome.value;
      const selectedPluginName = outcome.pluginName;
      if (rawOptions.json) {
        writeJsonReceipt(io.stdout, {
          ok: true,
          configSchemaVersion: 3,
          command: 'config:list',
          plugin: selectedPluginName,
          scope: rawOptions.local ? 'project' : rawOptions.scope ?? 'effective',
          projectLayer: rawOptions.local ? 'local' : 'shared',
          ...(resolved.schema ? { schema: resolved.schema } : {}),
          fields: resolved.fields,
        });
      } else {
        writeConfigReadHuman(io.stdout, resolved, selectedPluginName);
      }
    });

  config
    .command('get')
    .argument('[plugin]')
    .argument('[key]')
    .option('--catalog-channel <dist-tag>', 'use a specific current catalog dist-tag for this command')
    .option('--catalog-version <semver>', 'use a specific current catalog version for this command')
    .option('-s, --scope <scope>', 'read only project or user config')
    .option('--local', 'read only the current project local override layer', false)
    .option('-j, --json', 'print config as JSON', false)
    .option('-v, --verbose', 'show command diagnostics', false)
    .option('-D, --debug', 'write debug diagnostics to a log file', false)
    .option('--log-file <path>', 'write debug diagnostics to the specified file')
    .action(async (pluginName: string | undefined, key: string | undefined, rawOptions: RawConfigOptions) => {
      const context = createActionContext('config:get', rawOptions);
      const outcome = await runActionWithContext(context, async () => {
        resolveConfigProjectLayer(rawOptions);
        if (!rawOptions.local) resolveConfigReadResolution(rawOptions.scope);
        const execute = async (selectedPlugin: string) => {
        const projectLayer = resolveConfigProjectLayer(rawOptions);
        const { plugin, error } = await loadConfigPluginLookup(selectedPlugin, context);
        const result = await resolveConfigRead({
          pluginName: selectedPlugin,
          plugin,
          ...(error ? { pluginError: error } : {}),
          scope: rawOptions.local ? 'project' : resolveConfigReadResolution(rawOptions.scope),
          projectLayer,
          cwd: context.cwd,
          env: context.env,
        });
        if (!plugin && !hasConfigReadContent(result)) {
          throw new Error(
            `Unknown plugin "${selectedPlugin}". Use \`aw config reset ${selectedPlugin} -s user --yes\` or ` +
              `\`aw config reset ${selectedPlugin} -s project --yes\` to clean leftover config stores.`,
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
        };
        if (pluginName) return { cancelled: false as const, pluginName, value: await execute(pluginName) };
        if (!isWizardAvailable(context, rawOptions)) throw new Error(configCommandUsage('get'));
        const currentCandidates = await loadWizardCandidates(context, {});
        const storedCandidates = await loadStoredConfigWizardCandidates(
          context,
          configReadStoreLocations(rawOptions),
        );
        const candidates = mergeWizardCandidates(currentCandidates, storedCandidates);
        if (candidates.length === 0) {
          throw new Error('No plugin config candidates exist in the selected location.');
        }
        const result = await runCommandWizard(context, {
          command: 'config:get',
          candidates,
          initial: { plugins: [], key, scope: rawOptions.scope as Scope | undefined },
          pluginMode: 'single',
          equivalentCommand: (selection) => equivalentConfigCommand({
            command: 'get',
            plugin: selection.plugins[0]!,
            key,
            scope: rawOptions.scope,
            projectLayer: rawOptions.local ? 'local' : 'shared',
            catalogChannel: rawOptions.catalogChannel,
            catalogVersion: rawOptions.catalogVersion,
          }),
          execute: (selection) => execute(selection.plugins[0]!),
        });
        return result.cancelled
          ? { cancelled: true as const }
          : { cancelled: false as const, pluginName: result.selection!.plugins[0]!, value: result.value! };
      });
      if (outcome.cancelled) return;
      const resolved = outcome.value;
      const selectedPluginName = outcome.pluginName;
      if (rawOptions.json) {
        writeJsonReceipt(io.stdout, {
          ok: true,
          configSchemaVersion: 3,
          command: 'config:get',
          plugin: selectedPluginName,
          key,
          scope: rawOptions.local ? 'project' : rawOptions.scope ?? 'effective',
          projectLayer: rawOptions.local ? 'local' : 'shared',
          ...(resolved.schema ? { schema: resolved.schema } : {}),
          fields: resolved.fields,
        });
      } else {
        writeConfigReadHuman(io.stdout, resolved, selectedPluginName);
      }
    });

  config
    .command('set')
    .argument('[plugin]')
    .argument('[key]')
    .argument('[value]')
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
      pluginName: string | undefined,
      key: string | undefined,
      rawValue: string | undefined,
      rawOptions: RawConfigOptions,
    ) => {
      const context = createActionContext('config:set', rawOptions);
      const outcome = await runActionWithContext(context, async () => {
        const scope = resolveConfigWriteScope(rawOptions.scope);
        const projectLayer = resolveConfigProjectLayer(rawOptions);
        const execute = async (selectedPlugin: string, selectedKey: string, inputValue: unknown) => {
        const { plugin, error } = await loadConfigPluginLookup(selectedPlugin, context);
        if (!plugin) throw new Error(`Unknown plugin "${selectedPlugin}".`);
        if (!plugin.manifest.config?.schema) {
          throw new Error(`configSchemaUnavailable: Plugin "${selectedPlugin}" does not declare an AW config schema.`);
        }
        if (!plugin.manifest.config.schema[selectedKey]) {
          throw new Error(`Unknown config key "${selectedKey}".`);
        }
        const writeReceipt = await applyPluginConfigWrite({
          plugin,
          ...(error ? { pluginError: error } : {}),
          pluginName: selectedPlugin,
          scope,
          projectLayer,
          cwd: context.cwd,
          env: context.env,
          nativeCliRunner: context.nativeCliRunner,
          catalogChannel: rawOptions.catalogChannel,
          catalogVersion: rawOptions.catalogVersion,
          request: {
            updates: { [selectedKey]: inputValue },
          },
        });
        return {
          ok: writeReceipt.overallState === 'succeeded',
          receiptSchemaVersion: 3,
          command: 'config:set',
          ...writeReceipt,
          affectedFields: [{
            key: selectedKey,
            title: plugin?.manifest.config?.schema?.[selectedKey]?.title ?? selectedKey,
            kind: 'manifest' as const,
            reserved: false,
            action: 'set' as const,
            scope,
            ...(scope === 'project' ? { projectLayer } : {}),
          }],
        };
        };

        if (pluginName && key && rawValue !== undefined) {
          const inputValue = parseConfigValue(rawValue, rawOptions.valueJson === true);
          return {
            cancelled: false as const,
            key,
            value: await execute(pluginName, key, inputValue),
          };
        }
        if (!isWizardAvailable(context, rawOptions)) throw new Error(configCommandUsage('set'));
        const candidates = await loadWizardCandidates(context, {});
        if (pluginName) {
          const candidate = candidates.find((entry) => entry.pluginName === pluginName);
          if (!candidate) throw new Error(`Unknown plugin "${pluginName}".`);
          if (!candidate.configSchema) {
            throw new Error(`configSchemaUnavailable: Plugin "${pluginName}" does not declare an AW config schema.`);
          }
          if (key && !candidate.configSchema?.[key]) throw new Error(`Unknown config key "${key}".`);
        }
        const configurableCandidates = candidates.filter((candidate) => candidate.configSchema);
        if (configurableCandidates.length === 0) {
          throw new Error('configSchemaUnavailable: No current plugin declares an AW config schema.');
        }
        const result = await runCommandWizard(context, {
          command: 'config:set',
          candidates: configurableCandidates,
          initial: {
            plugins: pluginName ? [pluginName] : [],
            key,
            ...(rawValue !== undefined ? { value: rawValue } : {}),
            scope,
            projectLayer,
          },
          pluginMode: pluginName ? 'none' : 'single',
          valueJson: rawOptions.valueJson === true,
          promptForKey: key === undefined,
          promptForValue: rawValue === undefined,
          equivalentCommand: (selection) => {
            const field = candidates.find((entry) => entry.pluginName === selection.plugins[0])
              ?.configSchema?.[selection.key ?? ''];
            return equivalentConfigCommand({
              command: 'set',
              plugin: selection.plugins[0]!,
              key: selection.key!,
              value: field?.sensitive
                ? rawOptions.valueJson ? '"<sensitive-value>"' : '<sensitive-value>'
                : formatConfigCommandValue(selection.value, rawOptions.valueJson === true),
              scope: selection.scope ?? 'user',
              projectLayer: selection.projectLayer,
              valueJson: rawOptions.valueJson,
              catalogChannel: rawOptions.catalogChannel,
              catalogVersion: rawOptions.catalogVersion,
            });
          },
          commandIsTemplate: (selection) => candidates.find(
            (entry) => entry.pluginName === selection.plugins[0],
          )?.configSchema?.[selection.key ?? '']?.sensitive === true,
          resultState: overallResultState,
          execute: async (selection) => {
            const selectedPlugin = selection.plugins[0]!;
            const selectedKey = selection.key!;
            const schema = candidates.find((entry) => entry.pluginName === selectedPlugin)!.configSchema!;
            const updates = await coercePluginConfigUpdates({
              schema,
              updates: {
                [selectedKey]: parseConfigValue(selection.value, rawOptions.valueJson === true),
              },
              cwd: context.cwd,
            });
            return execute(selectedPlugin, selectedKey, updates[selectedKey]);
          },
        });
        return result.cancelled
          ? { cancelled: true as const }
          : { cancelled: false as const, key: result.selection!.key!, value: result.value! };
      });
      if (outcome.cancelled) return;
      const receipt = outcome.value;
      const selectedKey = outcome.key;
      if (rawOptions.json) {
        writeJsonReceipt(io.stdout, receipt);
      } else {
        writeLine(io.stdout, `已写入 ${receipt.plugin}.${selectedKey}（${configLayerLabel(receipt.scope, receipt.projectLayer)}配置）。`);
        if (receipt.projectLayer === 'local') {
          writeProjectLocalConfigNotice(io.stdout);
        }
        writeConfigApplyNotice(io.stderr, receipt);
      }
      commandExitState.exitCode = receipt.overallState === 'failed' ? 1 : 0;
    });

  config
    .command('unset')
    .argument('[plugin]')
    .argument('[key]')
    .option('--catalog-channel <dist-tag>', 'use a specific current catalog dist-tag for this command')
    .option('--catalog-version <semver>', 'use a specific current catalog version for this command')
    .option('-s, --scope <scope>', 'project or user')
    .option('--local', 'write only the current project local override layer', false)
    .option('-j, --json', 'print receipt as JSON', false)
    .option('-v, --verbose', 'show command diagnostics', false)
    .option('-D, --debug', 'write debug diagnostics to a log file', false)
    .option('--log-file <path>', 'write debug diagnostics to the specified file')
    .action(async (pluginName: string | undefined, key: string | undefined, rawOptions: RawConfigOptions) => {
      const context = createActionContext('config:unset', rawOptions);
      const outcome = await runActionWithContext(context, async () => {
        const scope = resolveConfigWriteScope(rawOptions.scope);
        const projectLayer = resolveConfigProjectLayer(rawOptions);
        const execute = async (selectedPlugin: string, selectedKey: string) => {
        const { plugin, error } = await loadConfigPluginLookup(selectedPlugin, context);
        if (plugin?.manifest.config?.schema && !plugin.manifest.config.schema[selectedKey]) {
          throw new Error(`Unknown config key "${selectedKey}".`);
        }
        const store = await readPluginConfigStore({
          pluginName: selectedPlugin,
          scope,
          ...(scope === 'project' ? { projectLayer } : {}),
          cwd: context.cwd,
          env: context.env,
        });
        const existed = Object.hasOwn(store.values, selectedKey);
        if (!plugin && !existed) throw new Error(`Unknown config key "${selectedKey}".`);
        const writeReceipt = await applyPluginConfigWrite({
          plugin,
          ...(error ? { pluginError: error } : {}),
          pluginName: selectedPlugin,
          scope,
          projectLayer,
          cwd: context.cwd,
          env: context.env,
          nativeCliRunner: context.nativeCliRunner,
          catalogChannel: rawOptions.catalogChannel,
          catalogVersion: rawOptions.catalogVersion,
          request: {
            removeKeys: [selectedKey],
          },
        });
        return {
          ok: writeReceipt.overallState === 'succeeded',
          receiptSchemaVersion: 3,
          command: 'config:unset',
          ...writeReceipt,
          removedKey: selectedKey,
          existed,
          affectedFields: [{
            key: selectedKey,
            title: plugin?.manifest.config?.schema?.[selectedKey]?.title ?? selectedKey,
            kind: 'manifest' as const,
            reserved: false,
            action: 'unset' as const,
            scope,
            ...(scope === 'project' ? { projectLayer } : {}),
          }],
        };
        };
        if (pluginName && key) {
          return { cancelled: false as const, value: await execute(pluginName, key) };
        }
        if (!isWizardAvailable(context, rawOptions)) throw new Error(configCommandUsage('unset'));
        const currentCandidates = (await loadWizardCandidates(context, {}))
          .filter((candidate) => candidate.configSchema);
        const storedCandidates = await loadStoredConfigWizardCandidates(context, [{ scope, projectLayer }]);
        const candidates = mergeWizardCandidates(currentCandidates, storedCandidates);
        if (pluginName && !candidates.some((entry) => entry.pluginName === pluginName)) {
          throw new Error(`Unknown plugin "${pluginName}".`);
        }
        if (candidates.length === 0) {
          throw new Error('No plugin config candidates exist in the selected location.');
        }
        const result = await runCommandWizard(context, {
          command: 'config:unset',
          candidates,
          initial: { plugins: pluginName ? [pluginName] : [], key, scope, projectLayer },
          pluginMode: pluginName ? 'none' : 'single',
          promptForKey: key === undefined,
          destructive: true,
          equivalentCommand: (selection) => equivalentConfigCommand({
            command: 'unset',
            plugin: selection.plugins[0]!,
            key: selection.key!,
            scope: selection.scope ?? 'user',
            projectLayer: selection.projectLayer,
            catalogChannel: rawOptions.catalogChannel,
            catalogVersion: rawOptions.catalogVersion,
          }),
          resultState: overallResultState,
          execute: (selection) => execute(selection.plugins[0]!, selection.key!),
        });
        return result.cancelled
          ? { cancelled: true as const }
          : { cancelled: false as const, value: result.value! };
      });
      if (outcome.cancelled) return;
      const receipt = outcome.value;
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
    .argument('[plugin]')
    .option('-s, --scope <scope>', 'project or user')
    .option('--local', 'reset only the current project local override layer', false)
    .option('-y, --yes', 'confirm destructive reset', false)
    .option('-j, --json', 'print receipt as JSON', false)
    .option('-v, --verbose', 'show command diagnostics', false)
    .option('-D, --debug', 'write debug diagnostics to a log file', false)
    .option('--log-file <path>', 'write debug diagnostics to the specified file')
    .action(async (pluginName: string | undefined, rawOptions: RawConfigOptions) => {
      const context = createActionContext('config:reset', rawOptions);
      const outcome = await runActionWithContext(context, async () => {
        const execute = async (
          selectedPlugin: string,
          selectedScope: Scope,
          projectLayer: 'shared' | 'local',
          confirmed: boolean,
        ) => {
        assertSafePluginConfigSegment(selectedPlugin);
        const store = await readPluginConfigStore({
          pluginName: selectedPlugin,
          scope: selectedScope,
          ...(selectedScope === 'project' ? { projectLayer } : {}),
          cwd: context.cwd,
          env: context.env,
        });
        if (store.exists && !confirmed) {
          throw new Error(
            `Reset requires confirmation. Re-run \`aw config reset ${selectedPlugin} -s ${selectedScope}${projectLayer === 'local' ? ' --local' : ''} --yes\` to delete this store.`,
          );
        }
        const { plugin, error } = await loadConfigPluginLookup(selectedPlugin, context);
        if (!plugin && !store.exists) throw new Error(`Unknown plugin "${selectedPlugin}".`);
        const affectedFields = await describeResetAffectedFields({
          pluginName: selectedPlugin,
          ...(plugin ? { plugin } : {}),
          ...(error ? { pluginError: error } : {}),
          scope: selectedScope,
          projectLayer,
          cwd: context.cwd,
          env: context.env,
        });
        const resetReceipt = await resetPluginConfigWithHelper({
          pluginName: selectedPlugin,
          scope: selectedScope,
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
        };

        const scope = resolveConfigWriteScope(rawOptions.scope);
        const projectLayer = resolveConfigProjectLayer(rawOptions);
        const needsWizard = pluginName === undefined || rawOptions.yes !== true;
        if (!needsWizard) {
          return {
            cancelled: false as const,
            value: await execute(pluginName, scope, projectLayer, true),
          };
        }
        if (!isWizardAvailable(context, rawOptions)) {
          if (!pluginName) throw new Error(configCommandUsage('reset'));
          return {
            cancelled: false as const,
            value: await execute(pluginName, scope, projectLayer, false),
          };
        }
        const currentCandidates = pluginName ? [] : await loadWizardCandidates(context, {});
        const candidatesByScope = new Map<Scope, CommandWizardPluginCandidate[]>();
        if (!pluginName && (rawOptions.scope === undefined || scope === 'user')) {
          candidatesByScope.set('user', mergeWizardCandidates(
            currentCandidates,
            await loadStoredConfigWizardCandidates(
              context,
              [{ scope: 'user', projectLayer: 'shared' }],
              { includeEmptyStores: true },
            ),
          ));
        }
        if (!pluginName && (rawOptions.scope === undefined || scope === 'project')) {
          candidatesByScope.set('project', mergeWizardCandidates(
            currentCandidates,
            await loadStoredConfigWizardCandidates(
              context,
              [{ scope: 'project', projectLayer }],
              { includeEmptyStores: true },
            ),
          ));
        }
        const candidates = mergeWizardCandidates(
          candidatesByScope.get('user') ?? [],
          candidatesByScope.get('project') ?? [],
        );
        if (!pluginName && candidates.length === 0) {
          throw new Error('No plugin config candidates exist in the selected location.');
        }
        const result = await runCommandWizard(context, {
          command: 'config:reset',
          candidates,
          initial: { plugins: pluginName ? [pluginName] : [], scope, projectLayer },
          pluginMode: pluginName ? 'none' : 'single',
          promptForScope: rawOptions.scope === undefined,
          destructive: true,
          isPluginVisible: (candidate, selection) => candidatesByScope
            .get(selection.scope ?? 'user')
            ?.some((entry) => entry.pluginName === candidate.pluginName) !== false,
          equivalentCommand: (selection) => equivalentConfigCommand({
            command: 'reset',
            plugin: selection.plugins[0]!,
            scope: selection.scope ?? 'user',
            projectLayer: selection.projectLayer,
            confirmed: true,
          }),
          resultState: overallResultState,
          execute: (selection) => execute(
            selection.plugins[0]!,
            selection.scope ?? 'user',
            selection.projectLayer ?? 'shared',
            true,
          ),
        });
        return result.cancelled
          ? { cancelled: true as const }
          : { cancelled: false as const, value: result.value! };
      });
      if (outcome.cancelled) return;
      const receipt = outcome.value;
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
