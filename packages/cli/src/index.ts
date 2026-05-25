#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Command, CommanderError, Option } from 'commander';

import { initCommand } from './commands/init.js';
import { installCommand } from './commands/install.js';
import { cleanupCommand, isCleanupExecutionFailure } from './commands/cleanup.js';
import { reinstallCommand } from './commands/reinstall.js';
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
import { uninstallCommand } from './commands/uninstall.js';
import { upgradeCommand } from './commands/upgrade.js';
import {
  normalizeUninstallCommandOptions,
  normalizeCatalogSelectorOptions,
  normalizeCleanupCommandOptions,
  resolveConfigReadResolution,
  resolveConfigProjectLayer,
  resolveConfigWriteScope,
  assertNoDeprecatedSkillTriggerOption,
  applyCatalogSelectorEnv,
  normalizeCommandOptions,
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
  buildCommandReceiptJson,
  buildCleanupReceiptJson,
  buildInitFailureReceiptJson,
  buildInitReceiptJson,
  renderCommandReceipt,
  renderCleanupReceipt,
  renderInitReceipt,
  type CliCommandResult,
} from './output/command-receipt.js';
import { resolveCliPackageRoot } from './utils/paths.js';
import { isCatalogResolutionError, resolveCatalogPlugins } from './utils/plugin-catalog.js';
import {
  assertSafePluginConfigSegment,
  coercePluginConfigValue,
  findConfigFieldEntry,
  hasConfigReadV2Content,
  isBuiltInConfigKey,
  parseBuiltInSkillTriggerKey,
  readPluginConfigStore,
  renderPluginConfigValueForDisplay,
  resolveConfigReadV2,
  resolveEffectivePluginConfig,
  resolveProjectScopedPluginConfigView,
  resolveProjectLocalPluginConfigView,
  summarizeEffectivePluginConfig,
  type PluginConfigIssue,
} from './utils/plugin-config.js';
import {
  applyBuiltInConfigWrite,
  applyPluginConfigWrite,
  describeResetAffectedFields,
  resetPluginConfigWithHelper,
} from './utils/plugin-config-write.js';
import { assertStrictSemVer } from './utils/manifest.js';
import type { ConfigFieldEntryV2, PluginManifestSource, PluginMeta, Scope } from './types.js';

export type { CliIo } from './commands/runtime.js';
export { parseSkillTriggerPreference } from './commands/options.js';

export type CliRuntimeOptions = CliExecutionContextInput;

function createDeprecatedSkillTriggerOption(): Option {
  return new Option('-t, --skill-trigger <preference>').hideHelp();
}

function assertNoDeprecatedSkillTriggerArgv(argv: string[]): void {
  const commandName = argv.find((token) => !token.startsWith('-'));
  if (
    commandName !== 'install' &&
    commandName !== 'upgrade' &&
    commandName !== 'reinstall'
  ) {
    return;
  }

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '-t' || token === '--skill-trigger' || token?.startsWith('--skill-trigger=')) {
      throw new Error(
        `\`${commandName}\` 不再接受 \`--skill-trigger\` / \`-t\`；请改用配置管理维护 skill trigger 偏好后再重试。`,
      );
    }
  }
}

function extractLegacyDiagnosePlugins(argv: string[]): string[] {
  const plugins: string[] = [];
  let positionalOnly = false;

  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token) {
      continue;
    }
    if (positionalOnly) {
      plugins.push(token);
      continue;
    }
    if (token === '--') {
      positionalOnly = true;
      continue;
    }
    if (
      token === '-s' ||
      token === '--scope' ||
      token === '-p' ||
      token === '--platform' ||
      token === '--log-file'
    ) {
      if (index + 1 < argv.length) {
        index += 1;
      }
      continue;
    }
    if (
      token.startsWith('--scope=') ||
      token.startsWith('--platform=') ||
      token.startsWith('--log-file=')
    ) {
      continue;
    }
    if (token.startsWith('-')) {
      continue;
    }
    plugins.push(token);
  }

  return plugins;
}

function createDiagnoseMigrationError(argv: string[]): Error | null {
  if (argv[0] !== 'diagnose') {
    return null;
  }

  const plugins = extractLegacyDiagnosePlugins(argv);
  const suggested = plugins.length > 0
    ? `aw status ${plugins.join(' ')} --verbose`
    : 'aw status --verbose';
  const details = argv.includes('--deep')
    ? '（原 `--deep` 诊断已并入 `status --verbose`）'
    : '';
  return new Error(`\`aw diagnose\` 已移除，请改用 \`${suggested}\`${details}。`);
}

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
  action: 'install' | 'uninstall' | 'upgrade',
  result: CliCommandResult,
): number {
  if (action === 'upgrade' && result.plugins.length === 0 && (result.skipped?.length ?? 0) > 0) {
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

function assertCleanupRequestProvided(pluginNames: string[], dependencyIndex: boolean): void {
  if (dependencyIndex && pluginNames.length > 0) {
    throw new Error('cleanup --dependency-index 不接受插件名。');
  }
  if (dependencyIndex || pluginNames.length === 1) {
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

async function loadConfigManifest(
  pluginName: string,
  context: CliExecutionContext,
): Promise<PluginMeta> {
  const { plugin, error } = await loadConfigPluginLookup(pluginName, context);
  if (error) {
    throw error;
  }
  if (!plugin) {
    throw new Error(
      `Unknown plugin "${pluginName}". Cannot read schema-aware config without a current catalog entry. ` +
        `Use \`aw config reset ${pluginName} -s user --yes\` or ` +
        `\`aw config reset ${pluginName} -s project --yes\` to clean leftover config stores.`,
    );
  }
  if (!plugin.manifest.config?.schema) {
    throw new Error(`Plugin "${pluginName}" does not declare an AW config schema.`);
  }
  return plugin;
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

function configScopeLabel(scope: Scope): string {
  return scope === 'user' ? '个人' : '当前项目';
}

function configLayerLabel(scope: Scope, projectLayer: 'shared' | 'local' = 'shared'): string {
  if (scope === 'user') {
    return '个人';
  }
  return projectLayer === 'local' ? '当前项目（本机私有覆盖）' : '当前项目';
}

function writeArtifactRefreshNotice(
  write: (text: string) => void,
  artifactRefresh: {
    attempted: boolean;
    status: 'succeeded' | 'failed' | 'skipped';
    error?: string;
    nextSteps?: string[];
  } | undefined,
): void {
  if (!artifactRefresh?.attempted || artifactRefresh.status !== 'failed') {
    return;
  }

  writeLine(
    write,
    `配置已保存，但相关项目文件刷新失败：${artifactRefresh.error ?? '请运行 aw status 检查详细诊断。'}`,
  );
  if (artifactRefresh.nextSteps && artifactRefresh.nextSteps.length > 0) {
    writeLine(write, `下一步：${artifactRefresh.nextSteps.join('；')}`);
  }
}

function formatConfigIssueRepairHint(
  pluginName: string,
  issue: PluginConfigIssue,
): string {
  const sourceScope = issue.source === 'user' || issue.source === 'project'
    ? ` -s ${issue.source}`
    : issue.source === 'projectLocal'
      ? ' -s project --local'
    : '';
  const setCommand = `aw config set ${pluginName} ${issue.key} <value>${sourceScope}`;

  if (issue.type === 'invalid-config' && sourceScope) {
    return [
      `可运行 \`${setCommand}\` 重新写入`,
      `\`aw config unset ${pluginName} ${issue.key}${sourceScope}\` 删除该值`,
      `或 \`aw config reset ${pluginName}${sourceScope}\` 清空这一层配置`,
    ].join('，');
  }

  return `可运行 \`${setCommand}\` 写入有效值。`;
}

function formatConfigIssues(
  pluginName: string,
  issues: PluginConfigIssue[],
): string[] {
  return issues.map((issue) => [
    `${issue.key}: ${issue.type} - ${issue.message}`,
    `修复建议：${formatConfigIssueRepairHint(pluginName, issue)}`,
  ].join('。'));
}

type LocalProjectConfigView = Awaited<ReturnType<typeof resolveProjectLocalPluginConfigView>>;
type ProjectScopedConfigView = Awaited<ReturnType<typeof resolveProjectScopedPluginConfigView>>;
type EffectiveConfigView = Awaited<ReturnType<typeof resolveEffectivePluginConfig>>;
type ScopedConfigView = Awaited<ReturnType<typeof resolveConfigForRead>>;

function isLocalProjectConfigView(value: ScopedConfigView): value is LocalProjectConfigView {
  return 'localStore' in value;
}

function isProjectScopedConfigView(value: ScopedConfigView): value is ProjectScopedConfigView {
  return 'entries' in value && 'repoVisibleArtifactConfig' in value && !('localStore' in value);
}

function writeProjectLocalConfigNotice(write: (text: string) => void): void {
  writeLine(write, '当前显示的是当前项目的本机私有覆盖层，不作为 repo-visible artifact 渲染输入。');
}

function writeProjectScopedConfigNotice(write: (text: string) => void): void {
  writeLine(
    write,
    '当前显示的是项目作用域的五层视图：manifest default < user < project shared < project local < effective；repo-visible artifact 仍只使用 project shared truth。',
  );
}

function renderLayerValue(value: string | number | boolean | '[redacted]' | undefined): string {
  return value === undefined ? '<unset>' : renderPluginConfigValueForDisplay(value);
}

function writeProjectScopedConfigEntry(
  write: (text: string) => void,
  key: string,
  entry: ProjectScopedConfigView['entries'][string],
): void {
  writeLine(
    write,
    `${key}: effective=${entry.effectiveSource} ${renderLayerValue(entry.effectiveValue)}; ` +
    `shared=${renderLayerValue(entry.projectSharedValue)}; local=${renderLayerValue(entry.projectLocalValue)}; ` +
    `repo-visible=${entry.repoVisibleArtifactSource} ${renderLayerValue(entry.repoVisibleArtifactValue)}`,
  );
  if (
    entry.effectiveSource === 'user' ||
    entry.effectiveSource === 'projectLocal' ||
    entry.effectiveValue !== entry.repoVisibleArtifactValue
  ) {
    writeLine(write, `  说明：本机 effective 值不改变 repo-visible artifact；共享真值仍取 project shared 层。`);
  }
}

function writeConfigList(
  write: (text: string) => void,
  pluginName: string,
  resolved: ScopedConfigView,
): void {
  if (isLocalProjectConfigView(resolved)) {
    writeProjectLocalConfigNotice(write);
  }
  if (isProjectScopedConfigView(resolved)) {
    writeProjectScopedConfigNotice(write);
    for (const key of Object.keys(resolved.schema)) {
      writeProjectScopedConfigEntry(write, key, resolved.entries[key]!);
    }
    if (resolved.repoVisibleArtifactConfig.issues.length > 0) {
      writeLine(
        write,
        `共享 artifact 渲染输入存在边界问题：${resolved.repoVisibleArtifactConfig.issues.map((issue) => issue.message).join('；')}`,
      );
    }
    if (resolved.issues.length > 0) {
      writeLine(write, `配置存在问题：${formatConfigIssues(pluginName, resolved.issues).join('；')}`);
    }
    return;
  }
  for (const [key, field] of Object.entries(resolved.schema)) {
    const source = resolved.sources[key] ?? 'missing';
    const configured = source === 'user' || source === 'project' || source === 'projectLocal';
    const required = field?.required ? 'required' : 'optional';
    const fromDefault = source === 'default' ? ', default' : '';
    writeLine(write, `${key}: ${source}${configured ? ', configured' : ''}, ${required}${fromDefault}`);
  }
  if (isLocalProjectConfigView(resolved)) {
    if (resolved.repoVisibleArtifactConfig.issues.length > 0) {
      writeLine(
        write,
        `共享 artifact 渲染输入仍以 project shared 为准：${resolved.repoVisibleArtifactConfig.issues.map((issue) => issue.message).join('；')}`,
      );
    }
  }
  if (resolved.issues.length > 0) {
    writeLine(write, `配置存在问题：${formatConfigIssues(pluginName, resolved.issues).join('；')}`);
  }
}

function writeConfigGet(
  write: (text: string) => void,
  pluginName: string,
  resolved: ScopedConfigView,
  key?: string,
): void {
  if (isLocalProjectConfigView(resolved)) {
    writeProjectLocalConfigNotice(write);
  }
  if (isProjectScopedConfigView(resolved)) {
    writeProjectScopedConfigNotice(write);
    if (key) {
      const entry = resolved.entries[key];
      if (!entry) {
        throw new Error(`Unknown config key "${key}".`);
      }
      writeLine(write, `effective=${renderLayerValue(entry.effectiveValue)}`);
      writeLine(write, `default=${renderLayerValue(entry.defaultValue)}`);
      writeLine(write, `user=${renderLayerValue(entry.userValue)}`);
      writeLine(write, `project shared=${renderLayerValue(entry.projectSharedValue)}`);
      writeLine(write, `project local=${renderLayerValue(entry.projectLocalValue)}`);
      writeLine(
        write,
        `repo-visible artifact truth=${entry.repoVisibleArtifactSource} ${renderLayerValue(entry.repoVisibleArtifactValue)}`,
      );
      if (
        entry.effectiveSource === 'user' ||
        entry.effectiveSource === 'projectLocal' ||
        entry.effectiveValue !== entry.repoVisibleArtifactValue
      ) {
        writeLine(write, '说明：本机 effective 值不会改写 repo-visible artifact。');
      }
    } else {
      for (const [entryKey, entry] of Object.entries(resolved.entries)) {
        writeProjectScopedConfigEntry(write, entryKey, entry);
      }
    }
    if (resolved.repoVisibleArtifactConfig.issues.length > 0) {
      writeLine(
        write,
        `共享 artifact 渲染输入存在边界问题：${resolved.repoVisibleArtifactConfig.issues.map((issue) => issue.message).join('；')}`,
      );
    }
    if (resolved.issues.length > 0) {
      writeLine(write, `配置存在问题：${formatConfigIssues(pluginName, resolved.issues).join('；')}`);
    }
    return;
  }
  if (key) {
    if (!('schema' in resolved) || !resolved.schema[key]) {
      throw new Error(`Unknown config key "${key}".`);
    }
    const value = resolved.redactedValues[key];
    writeLine(write, value === undefined ? '' : renderPluginConfigValueForDisplay(value));
  } else {
    for (const [entryKey, value] of Object.entries(resolved.redactedValues)) {
      writeLine(write, `${entryKey}=${renderPluginConfigValueForDisplay(value)}`);
    }
  }
  if (resolved.issues.length > 0) {
    writeLine(write, `配置存在问题：${formatConfigIssues(pluginName, resolved.issues).join('；')}`);
  }
}

async function resolveConfigForRead(options: {
  pluginName: string;
  manifest: PluginManifestSource;
  scopeOrEffective: Scope | 'effective';
  localOnly?: boolean;
  context: CliExecutionContext;
}) {
  if (options.localOnly) {
    return resolveProjectLocalPluginConfigView({
      pluginName: options.pluginName,
      manifest: options.manifest,
      cwd: options.context.cwd,
      env: options.context.env,
    });
  }
  if (options.scopeOrEffective === 'project') {
    return resolveProjectScopedPluginConfigView({
      pluginName: options.pluginName,
      manifest: options.manifest,
      cwd: options.context.cwd,
      env: options.context.env,
    });
  }
  const resolved = await resolveEffectivePluginConfig({
    pluginName: options.pluginName,
    manifest: options.manifest,
    cwd: options.context.cwd,
    env: options.context.env,
  });

  if (options.scopeOrEffective === 'effective') {
    return resolved;
  }

  const scopedStore = resolved.stores[options.scopeOrEffective];
  const scopedValues: Record<string, string | number | boolean> = {};
  const scopedRedactedValues: Record<string, string | number | boolean | '[redacted]'> = {};
  const scopedSources: Record<string, Scope | 'default' | 'missing'> = {};
  const scopedIssues = [];
  for (const [key, field] of Object.entries(resolved.schema)) {
    scopedSources[key] = 'missing';
    if (field.default !== undefined) {
      try {
        const coerced = await coercePluginConfigValue({
          key,
          field,
          value: field.default,
          projectRoot: resolved.projectRoot,
        });
        scopedValues[key] = coerced;
        scopedRedactedValues[key] = field.sensitive ? '[redacted]' : coerced;
        scopedSources[key] = 'default';
      } catch (error) {
        scopedIssues.push({
          type: 'invalid-config' as const,
          key,
          source: 'default' as const,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (Object.hasOwn(scopedStore.values, key)) {
      scopedSources[key] = options.scopeOrEffective;
      try {
        const coerced = await coercePluginConfigValue({
          key,
          field,
          value: scopedStore.values[key],
          projectRoot: resolved.projectRoot,
        });
        scopedValues[key] = coerced;
        scopedRedactedValues[key] = field.sensitive ? '[redacted]' : coerced;
      } catch (error) {
        delete scopedValues[key];
        delete scopedRedactedValues[key];
        scopedIssues.push({
          type: 'invalid-config' as const,
          key,
          source: options.scopeOrEffective,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (field.required && scopedValues[key] === undefined) {
      scopedIssues.push({
        type: 'missing-required' as const,
        key,
        source: scopedSources[key],
        message: `Config "${key}" is required.`,
      });
    }
  }

  return {
    ...resolved,
    values: scopedValues,
    redactedValues: scopedRedactedValues,
    sources: scopedSources,
    issues: scopedIssues,
    ignoredUnknownKeys: resolved.ignoredUnknownKeys.filter((entry) => entry.scope === options.scopeOrEffective),
  };
}

function renderConfigFieldState(field: ConfigFieldEntryV2): string {
  if (field.valueState === 'invalid') {
    return 'invalid-config';
  }
  return field.valueState;
}

function writeConfigReadV2Human(
  write: (text: string) => void,
  resolved: Awaited<ReturnType<typeof resolveConfigReadV2>>,
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
  for (const legacy of resolved.legacyConfigStores) {
    writeLine(
      write,
      `${legacy.storeKind}: storeOnly (${legacy.reason})`,
    );
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
    .addOption(createDeprecatedSkillTriggerOption())
    .option('--adopt-existing', 'adopt existing project-scope shared artifacts', false)
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
          skillTrigger?: string;
          adoptExisting?: boolean;
          scriptTimeout?: string;
          json?: boolean;
        } & RawDiagnosticsOptions,
      ) => {
        const context = createActionContext('install', rawOptions);
        const receipt = await runActionWithContext(
          context,
          async () => {
            assertInstallPluginsProvided(plugins ?? []);
            assertNoDeprecatedSkillTriggerOption(rawOptions, 'install');
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
          writeJsonReceipt(io.stdout, buildCommandReceiptJson('install', receipt));
        } else {
          for (const line of renderCommandReceipt('install', receipt)) {
            writeLine(io.stdout, line);
          }
        }
        writeWarnings(io.stderr, receipt.result.warnings, { actionableOnly: true });
        commandExitState.exitCode = resolveCommandReceiptExitCode('install', receipt.result);
      },
    );

  program
    .command('uninstall')
    .argument('[plugins...]')
    .option('-s, --scope <scope>', 'project or user')
    .option('-p, --platform <platform>', 'codex | claude | both')
    .option('--script-timeout <ms>', 'override plugin lifecycle script timeout in milliseconds')
    .option('--remove-config', 'remove the AW-managed config store after uninstall succeeds', false)
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
        removeConfig?: boolean;
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
        writeJsonReceipt(io.stdout, buildCommandReceiptJson('uninstall', receipt));
      } else {
        for (const line of renderCommandReceipt('uninstall', receipt)) {
          writeLine(io.stdout, line);
        }
      }
      writeWarnings(io.stderr, receipt.result.warnings, { actionableOnly: true });
      commandExitState.exitCode = resolveCommandReceiptExitCode('uninstall', receipt.result);
    });

  addCatalogSelectorOptions(
    program
      .command('upgrade'),
  )
    .argument('[plugins...]')
    .option('-a, --all', 'upgrade all plugins', false)
    .option('-s, --scope <scope>', 'project or user')
    .option('-p, --platform <platform>', 'codex | claude | both')
    .addOption(createDeprecatedSkillTriggerOption())
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
          skillTrigger?: string;
          scriptTimeout?: string;
          json?: boolean;
        } & RawDiagnosticsOptions,
      ) => {
        const context = createActionContext('upgrade', rawOptions);
        const receipt = await runActionWithContext(
          context,
          async () => {
            assertUpgradeRequestProvided(plugins ?? [], rawOptions.all === true);
            assertNoDeprecatedSkillTriggerOption(rawOptions, 'upgrade');
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
          writeJsonReceipt(io.stdout, buildCommandReceiptJson('upgrade', receipt));
        } else {
          for (const line of renderCommandReceipt('upgrade', receipt)) {
            writeLine(io.stdout, line);
          }
        }
        writeWarnings(io.stderr, receipt.result.warnings, { actionableOnly: true });
        commandExitState.exitCode = resolveCommandReceiptExitCode('upgrade', receipt.result);
      },
    );

  program
    .command('cleanup')
    .argument('[plugins...]')
    .option('-s, --scope <scope>', 'project or user')
    .option('-p, --platform <platform>', 'codex | claude | both')
    .option('--force', 'allow high-risk cleanup after evaluating backups and affected dependents', false)
    .option('--remove-config', 'remove the AW-managed config store after cleanup succeeds', false)
    .option('--dependency-index', 'prune stale dependency index entries', false)
    .option('--prune-stale <token>', 'retire a single stale dependency index reference')
    .option('-y, --yes', 'confirm dependency-index prune actions', false)
    .option('--script-timeout <ms>', 'override plugin lifecycle script timeout in milliseconds')
    .option('-j, --json', 'print cleanup result as JSON', false)
    .option('-v, --verbose', 'show command diagnostics', false)
    .option('-D, --debug', 'write debug diagnostics to a log file', false)
    .option('--log-file <path>', 'write debug diagnostics to the specified file')
    .action(async (
      plugins: string[],
      rawOptions: {
        scope?: string;
        platform?: string;
        force?: boolean;
        removeConfig?: boolean;
        dependencyIndex?: boolean;
        pruneStale?: string;
        yes?: boolean;
        scriptTimeout?: string;
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
          assertCleanupRequestProvided(plugins ?? [], commandOptions.dependencyIndex);
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
        writeJsonReceipt(io.stdout, buildCleanupReceiptJson(result));
      } else {
        for (const line of renderCleanupReceipt(result)) {
          writeLine(io.stdout, line);
        }
      }
      writeWarnings(io.stderr, result.warnings, { actionableOnly: true });
      commandExitState.exitCode = isCleanupExecutionFailure(result.payload) ? 1 : 0;
    });

  addCatalogSelectorOptions(
    program
      .command('reinstall'),
  )
    .argument('[plugins...]')
    .option('-s, --scope <scope>', 'project or user')
    .option('-p, --platform <platform>', 'codex | claude | both')
    .addOption(createDeprecatedSkillTriggerOption())
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
        skillTrigger?: string;
        scriptTimeout?: string;
        json?: boolean;
      } & RawDiagnosticsOptions,
    ) => {
      const context = createActionContext('reinstall', rawOptions);
      const receipt = await runActionWithContext(
        context,
        async () => {
          assertNoDeprecatedSkillTriggerOption(rawOptions, 'reinstall');
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
        writeJsonReceipt(io.stdout, {
          ok: true,
          command: 'reinstall',
          receipt: buildCommandReceiptJson('install', receipt),
        });
      } else {
        const lines = renderCommandReceipt('install', receipt, {
          headlineVariant: 'reinstall',
        });
        for (const line of lines) {
          writeLine(io.stdout, line);
        }
      }
      writeWarnings(io.stderr, receipt.result.warnings, { actionableOnly: true });
      commandExitState.exitCode = resolveCommandReceiptExitCode('install', receipt.result);
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
        const result = await resolveConfigReadV2({
          pluginName,
          plugin,
          ...(error ? { pluginError: error } : {}),
          scope: rawOptions.local ? 'project' : resolveConfigReadResolution(rawOptions.scope),
          projectLayer,
          cwd: context.cwd,
          env: context.env,
        });
        if (!plugin && !hasConfigReadV2Content(result)) {
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
          configSchemaVersion: 2,
          command: 'config:list',
          plugin: pluginName,
          scope: rawOptions.local ? 'project' : rawOptions.scope ?? 'effective',
          projectLayer: rawOptions.local ? 'local' : 'shared',
          ...(resolved.schema ? { schema: resolved.schema } : {}),
          fields: resolved.fields,
          ...(resolved.legacyConfigStores.length > 0
            ? { legacyConfigStores: resolved.legacyConfigStores }
            : {}),
        });
      } else {
        writeConfigReadV2Human(io.stdout, resolved, pluginName);
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
        if (key && rawOptions.local && isBuiltInConfigKey(key)) {
          throw new Error('project local 层不支持按字段读取 SkillTrigger 内建值；请改用 `--scope project` 查看生效值，或整层 reset 清理误写入值。');
        }
        const { plugin, error } = await loadConfigPluginLookup(pluginName, context);
        const result = await resolveConfigReadV2({
          pluginName,
          plugin,
          ...(error ? { pluginError: error } : {}),
          scope: rawOptions.local ? 'project' : resolveConfigReadResolution(rawOptions.scope),
          projectLayer,
          cwd: context.cwd,
          env: context.env,
        });
        if (!plugin && !hasConfigReadV2Content(result)) {
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
        if (result.legacyConfigStores.length > 0 && !parseBuiltInSkillTriggerKey(key)) {
          throw new Error(
            `${pluginName} 只剩 storeOnly 旧配置，不能按字段读取普通 raw value。` +
              `请运行 \`aw config reset ${pluginName} -s user --yes\` 或 ` +
              `\`aw config reset ${pluginName} -s project --yes\` 清理对应 store。`,
          );
        }
        if (parseBuiltInSkillTriggerKey(key)) {
          throw new Error(`Unknown config key "${key}".`);
        }
        if (plugin?.manifest.config?.schema?.[key] === undefined) {
          throw new Error(`Unknown config key "${key}".`);
        }
        return result;
      });
      if (rawOptions.json) {
        writeJsonReceipt(io.stdout, {
          ok: true,
          configSchemaVersion: 2,
          command: 'config:get',
          plugin: pluginName,
          key,
          scope: rawOptions.local ? 'project' : rawOptions.scope ?? 'effective',
          projectLayer: rawOptions.local ? 'local' : 'shared',
          ...(resolved.schema ? { schema: resolved.schema } : {}),
          fields: resolved.fields,
          ...(resolved.legacyConfigStores.length > 0
            ? { legacyConfigStores: resolved.legacyConfigStores }
            : {}),
        });
      } else {
        writeConfigReadV2Human(io.stdout, resolved, pluginName);
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
        if (isBuiltInConfigKey(key)) {
          const writeReceipt = await applyBuiltInConfigWrite({
            pluginName,
            plugin,
            ...(error ? { pluginError: error } : {}),
            scope,
            projectLayer,
            cwd: context.cwd,
            env: context.env,
            nativeCliRunner: context.nativeCliRunner,
            key,
            action: 'set',
            value: inputValue,
          });
          return {
            ok: true,
            receiptSchemaVersion: 2,
            command: 'config:set',
            ...writeReceipt,
          };
        }
        const writeReceipt = await applyPluginConfigWrite({
          plugin,
          ...(error ? { pluginError: error } : {}),
          pluginName,
          scope,
          projectLayer,
          cwd: context.cwd,
          env: context.env,
          nativeCliRunner: context.nativeCliRunner,
          request: {
            updates: { [key]: inputValue },
          },
        });
        return {
          ok: true,
          receiptSchemaVersion: 2,
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
        writeArtifactRefreshNotice(io.stderr, 'artifactRefresh' in receipt ? receipt.artifactRefresh : undefined);
      }
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
        if (isBuiltInConfigKey(key)) {
          const writeReceipt = await applyBuiltInConfigWrite({
            pluginName,
            plugin,
            ...(error ? { pluginError: error } : {}),
            scope,
            projectLayer,
            cwd: context.cwd,
            env: context.env,
            nativeCliRunner: context.nativeCliRunner,
            key,
            action: 'unset',
          });
          return {
            ok: true,
            receiptSchemaVersion: 2,
            command: 'config:unset',
            ...writeReceipt,
            removedKey: key,
            existed: writeReceipt.existed ?? false,
          };
        }
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
          request: {
            removeKeys: [key],
          },
        });
        return {
          ok: true,
          receiptSchemaVersion: 2,
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
        writeArtifactRefreshNotice(io.stderr, 'artifactRefresh' in receipt ? receipt.artifactRefresh : undefined);
      }
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
          ...(error ? { pluginError: error } : {}),
          ...(plugin ? { plugin } : {}),
        });
        return {
          ok: true,
          receiptSchemaVersion: 2,
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
        writeArtifactRefreshNotice(io.stderr, receipt.artifactRefresh);
      }
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
    assertNoDeprecatedSkillTriggerArgv(argv);
    const diagnoseMigrationError = createDiagnoseMigrationError(argv);
    if (diagnoseMigrationError) {
      throw diagnoseMigrationError;
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
