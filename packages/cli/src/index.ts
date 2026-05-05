#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Command, CommanderError } from 'commander';

import { initCommand } from './commands/init.js';
import { installCommand } from './commands/install.js';
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
  resolveConfigReadResolution,
  resolveConfigWriteScope,
  normalizeCommandOptions,
  normalizeInstallCommandOptions,
  normalizeStatusCommandOptions,
  normalizeUpgradeCommandOptions,
  parseSkillTriggerPreference,
} from './commands/options.js';
import {
  isCommandWarningError,
} from './types.js';
import { formatWarnings } from './output/reporter.js';
import {
  buildCommandReceiptJson,
  buildInitReceiptJson,
  renderCommandReceipt,
  renderInitReceipt,
  type CliCommandExecutionGroup,
  type CliCommandResult,
} from './output/command-receipt.js';
import { resolveCliPackageRoot } from './utils/paths.js';
import { resolveCatalogPlugins } from './utils/plugin-catalog.js';
import {
  assertSafePluginConfigSegment,
  coercePluginConfigValue,
  readPluginConfigStore,
  renderPluginConfigValueForDisplay,
  resolveEffectivePluginConfig,
  summarizeEffectivePluginConfig,
  type PluginConfigIssue,
} from './utils/plugin-config.js';
import {
  applyPluginConfigWrite,
  resetPluginConfigWithHelper,
} from './utils/plugin-config-write.js';
import type { PluginManifestSource, PluginMeta, Scope } from './types.js';

export type { CliIo } from './commands/runtime.js';
export { parseSkillTriggerPreference } from './commands/options.js';

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
  if (typeof packageJson.version !== 'string' || packageJson.version.trim().length === 0) {
    throw new Error('Unable to resolve @yiliang/aw version from package.json.');
  }
  return packageJson.version;
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
  json?: boolean;
  valueJson?: boolean;
  yes?: boolean;
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
  assertSafePluginConfigSegment(pluginName);
  let plugins: Awaited<ReturnType<typeof resolveCatalogPlugins>>['plugins'];
  try {
    ({ plugins } = await resolveCatalogPlugins([pluginName], context.env));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === `Unknown plugin "${pluginName}".`) {
      throw new Error(
        `${message} Cannot read schema-aware config without a current catalog entry. ` +
          `Use \`aw config reset ${pluginName} -s user --yes\` or ` +
          `\`aw config reset ${pluginName} -s project --yes\` to clean leftover config stores.`,
      );
    }
    throw error;
  }
  const plugin = plugins[0];
  if (!plugin.manifest.config?.schema) {
    throw new Error(`Plugin "${pluginName}" does not declare an AW config schema.`);
  }
  return plugin;
}

function writeJsonReceipt(write: (text: string) => void, payload: unknown): void {
  writeLine(write, JSON.stringify(payload, null, 2));
}

function writeArtifactRefreshNotice(
  write: (text: string) => void,
  artifactRefresh: {
    attempted: boolean;
    status: 'succeeded' | 'failed' | 'skipped';
    error?: string;
  } | undefined,
): void {
  if (!artifactRefresh?.attempted || artifactRefresh.status !== 'failed') {
    return;
  }

  writeLine(
    write,
    `配置已保存，但 artifact refresh 失败：${artifactRefresh.error ?? '请运行 aw status 检查详细诊断。'}`,
  );
}

function formatConfigIssueRepairHint(
  pluginName: string,
  issue: PluginConfigIssue,
): string {
  const sourceScope = issue.source === 'user' || issue.source === 'project'
    ? ` -s ${issue.source}`
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

function writeConfigList(
  write: (text: string) => void,
  pluginName: string,
  resolved: Awaited<ReturnType<typeof resolveEffectivePluginConfig>>,
): void {
  for (const [key, field] of Object.entries(resolved.schema)) {
    const source = resolved.sources[key] ?? 'missing';
    const configured = source === 'user' || source === 'project';
    const required = field.required ? 'required' : 'optional';
    const fromDefault = source === 'default' ? ', default' : '';
    writeLine(write, `${key}: ${source}${configured ? ', configured' : ''}, ${required}${fromDefault}`);
  }
  if (resolved.issues.length > 0) {
    writeLine(write, `配置存在问题：${formatConfigIssues(pluginName, resolved.issues).join('；')}`);
  }
}

function writeConfigGet(
  write: (text: string) => void,
  pluginName: string,
  resolved: Awaited<ReturnType<typeof resolveEffectivePluginConfig>>,
  key?: string,
): void {
  if (key) {
    if (!resolved.schema[key]) {
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
  context: CliExecutionContext;
}) {
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
    rawOptions: RawDiagnosticsOptions,
  ): CliExecutionContext =>
    createCliExecutionContext({
      ...options,
      cwd,
      env,
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

  program
    .command('init')
    .option('-f, --force', 'refresh the local marketplace bundle', false)
    .option('-j, --json', 'print receipt as JSON', false)
    .option('-v, --verbose', 'show command diagnostics', false)
    .option('-D, --debug', 'write debug diagnostics to a log file', false)
    .option('--log-file <path>', 'write debug diagnostics to the specified file')
    .action(async (rawOptions: { force?: boolean; json?: boolean } & RawDiagnosticsOptions) => {
      const context = createActionContext('init', rawOptions);
      const result = await runActionWithContext(context, () =>
        initCommand({ force: rawOptions.force, env: context.env }),
      );
      if (rawOptions.json) {
        writeJsonReceipt(io.stdout, buildInitReceiptJson(result));
      } else {
        for (const line of renderInitReceipt(result)) {
          writeLine(io.stdout, line);
        }
      }
      writeWarnings(io.stderr, result.warnings, { actionableOnly: true });
    });

  program
    .command('install')
    .argument('[plugins...]')
    .option('-s, --scope <scope>', 'project or user', 'user')
    .option('-p, --platform <platform>', 'codex | claude | both | auto', 'auto')
    .option('-t, --skill-trigger <preference>', 'default | manual | auto', parseSkillTriggerPreference)
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
          skillTrigger?: string;
          scriptTimeout?: string;
          json?: boolean;
        } & RawDiagnosticsOptions,
      ) => {
        const context = createActionContext('install', rawOptions);
        const receipt = await runActionWithContext(
          context,
          async () => {
            const commandOptions = normalizeInstallCommandOptions({
              cwd,
              ...rawOptions,
            });
            assertInstallPluginsProvided(plugins ?? []);
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
    .option('-s, --scope <scope>', 'project or user', 'user')
    .option('-p, --platform <platform>', 'codex | claude | both | auto', 'auto')
    .option('--script-timeout <ms>', 'override plugin lifecycle script timeout in milliseconds')
    .option('-j, --json', 'print receipt as JSON', false)
    .option('-v, --verbose', 'show command diagnostics', false)
    .option('-D, --debug', 'write debug diagnostics to a log file', false)
    .option('--log-file <path>', 'write debug diagnostics to the specified file')
    .action(async (
      plugins: string[],
      rawOptions: { scope?: string; platform?: string; scriptTimeout?: string; json?: boolean } & RawDiagnosticsOptions,
    ) => {
      const context = createActionContext('uninstall', rawOptions);
      const receipt = await runActionWithContext(
        context,
        async () => {
          const commandOptions = normalizeCommandOptions({
            cwd,
            ...rawOptions,
          });
          assertUninstallPluginsProvided(plugins ?? []);
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

  program
    .command('upgrade')
    .argument('[plugins...]')
    .option('-a, --all', 'upgrade all plugins', false)
    .option('-s, --scope <scope>', 'project or user', 'user')
    .option('-p, --platform <platform>', 'codex | claude | both | auto', 'auto')
    .option('-t, --skill-trigger <preference>', 'default | manual | auto', parseSkillTriggerPreference)
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
          skillTrigger?: string;
          scriptTimeout?: string;
          json?: boolean;
        } & RawDiagnosticsOptions,
      ) => {
        const context = createActionContext('upgrade', rawOptions);
        const receipt = await runActionWithContext(
          context,
          async () => {
            const commandOptions = normalizeUpgradeCommandOptions({
              cwd,
              ...rawOptions,
            });
            assertUpgradeRequestProvided(plugins ?? [], commandOptions.all === true);
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

  const config = program
    .command('config')
    .description('Manage AW plugin configuration');

  config
    .command('list')
    .argument('<plugin>')
    .option('-s, --scope <scope>', 'read only project or user config')
    .option('-j, --json', 'print config as JSON', false)
    .option('-v, --verbose', 'show command diagnostics', false)
    .option('-D, --debug', 'write debug diagnostics to a log file', false)
    .option('--log-file <path>', 'write debug diagnostics to the specified file')
    .action(async (pluginName: string, rawOptions: RawConfigOptions) => {
      const context = createActionContext('config:list', rawOptions);
      const resolved = await runActionWithContext(context, async () => {
        const plugin = await loadConfigManifest(pluginName, context);
        return resolveConfigForRead({
          pluginName,
          manifest: plugin.manifest,
          scopeOrEffective: resolveConfigReadResolution(rawOptions.scope),
          context,
        });
      });
      if (rawOptions.json) {
        writeJsonReceipt(io.stdout, {
          ok: true,
          command: 'config:list',
          plugin: pluginName,
          summary: summarizeEffectivePluginConfig(resolved),
        });
      } else {
        writeConfigList(io.stdout, pluginName, resolved);
      }
    });

  config
    .command('get')
    .argument('<plugin>')
    .argument('[key]')
    .option('-s, --scope <scope>', 'read only project or user config')
    .option('-j, --json', 'print config as JSON', false)
    .option('-v, --verbose', 'show command diagnostics', false)
    .option('-D, --debug', 'write debug diagnostics to a log file', false)
    .option('--log-file <path>', 'write debug diagnostics to the specified file')
    .action(async (pluginName: string, key: string | undefined, rawOptions: RawConfigOptions) => {
      const context = createActionContext('config:get', rawOptions);
      const resolved = await runActionWithContext(context, async () => {
        const plugin = await loadConfigManifest(pluginName, context);
        const configForRead = await resolveConfigForRead({
          pluginName,
          manifest: plugin.manifest,
          scopeOrEffective: resolveConfigReadResolution(rawOptions.scope),
          context,
        });
        if (key && !configForRead.schema[key]) {
          throw new Error(`Unknown config key "${key}".`);
        }
        return configForRead;
      });
      if (rawOptions.json) {
        writeJsonReceipt(io.stdout, {
          ok: true,
          command: 'config:get',
          plugin: pluginName,
          key,
          summary: summarizeEffectivePluginConfig(resolved),
          value: key ? resolved.redactedValues[key] : resolved.redactedValues,
          source: key ? resolved.sources[key] : resolved.sources,
        });
      } else {
        writeConfigGet(io.stdout, pluginName, resolved, key);
      }
    });

  config
    .command('set')
    .argument('<plugin>')
    .argument('<key>')
    .argument('<value>')
    .option('-s, --scope <scope>', 'project or user')
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
        const plugin = await loadConfigManifest(pluginName, context);
        const scope = resolveConfigWriteScope(rawOptions.scope);
        const inputValue = rawOptions.valueJson ? JSON.parse(rawValue) : rawValue;
        const writeReceipt = await applyPluginConfigWrite({
          plugin,
          pluginName,
          scope,
          cwd: context.cwd,
          env: context.env,
          request: {
            updates: { [key]: inputValue },
          },
        });
        return {
          ok: true,
          command: 'config:set',
          ...writeReceipt,
        };
      });
      if (rawOptions.json) {
        writeJsonReceipt(io.stdout, receipt);
      } else {
        writeLine(io.stdout, `已写入 ${receipt.plugin}.${key} (${receipt.scope})。`);
        writeArtifactRefreshNotice(io.stderr, receipt.artifactRefresh);
      }
    });

  config
    .command('unset')
    .argument('<plugin>')
    .argument('<key>')
    .option('-s, --scope <scope>', 'project or user')
    .option('-j, --json', 'print receipt as JSON', false)
    .option('-v, --verbose', 'show command diagnostics', false)
    .option('-D, --debug', 'write debug diagnostics to a log file', false)
    .option('--log-file <path>', 'write debug diagnostics to the specified file')
    .action(async (pluginName: string, key: string, rawOptions: RawConfigOptions) => {
      const context = createActionContext('config:unset', rawOptions);
      const receipt = await runActionWithContext(context, async () => {
        const plugin = await loadConfigManifest(pluginName, context);
        if (!plugin.manifest.config!.schema[key]) {
          throw new Error(`Unknown config key "${key}".`);
        }
        const scope = resolveConfigWriteScope(rawOptions.scope);
        const store = await readPluginConfigStore({
          pluginName,
          scope,
          cwd: context.cwd,
          env: context.env,
        });
        const existed = Object.hasOwn(store.values, key);
        const writeReceipt = await applyPluginConfigWrite({
          plugin,
          pluginName,
          scope,
          cwd: context.cwd,
          env: context.env,
          request: {
            removeKeys: [key],
          },
        });
        return {
          ok: true,
          command: 'config:unset',
          ...writeReceipt,
          removedKey: key,
          existed,
        };
      });
      if (rawOptions.json) {
        writeJsonReceipt(io.stdout, receipt);
      } else {
        writeLine(io.stdout, receipt.existed
          ? `已删除 ${receipt.plugin}.${receipt.removedKey} (${receipt.scope})。`
          : `${receipt.plugin}.${receipt.removedKey} (${receipt.scope}) 原本不存在。`);
        writeArtifactRefreshNotice(io.stderr, receipt.artifactRefresh);
      }
    });

  config
    .command('reset')
    .argument('<plugin>')
    .option('-s, --scope <scope>', 'project or user')
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
        const store = await readPluginConfigStore({
          pluginName,
          scope,
          cwd: context.cwd,
          env: context.env,
        });
        if (store.exists && !rawOptions.yes) {
          throw new Error(
            `Reset requires confirmation. Re-run \`aw config reset ${pluginName} -s ${scope} --yes\` to delete this store.`,
          );
        }
        let plugin: PluginMeta | undefined;
        try {
          plugin = await loadConfigManifest(pluginName, context);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (
            !message.startsWith(`Unknown plugin "${pluginName}".`) &&
            message !== `Plugin "${pluginName}" does not declare an AW config schema.`
          ) {
            throw error;
          }
        }
        const resetReceipt = await resetPluginConfigWithHelper({
          pluginName,
          scope,
          cwd: context.cwd,
          env: context.env,
          plugin,
        });
        return {
          ok: true,
          command: 'config:reset',
          ...resetReceipt,
        };
      });
      if (rawOptions.json) {
        writeJsonReceipt(io.stdout, receipt);
      } else {
        writeLine(io.stdout, receipt.deleted
          ? `已重置 ${receipt.plugin} 的 ${receipt.scope} 配置。`
          : `${receipt.plugin} 没有可重置的 ${receipt.scope} 配置。`);
        writeArtifactRefreshNotice(io.stderr, receipt.artifactRefresh);
      }
    });

  program
    .command('status')
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
    if (argv.length === 0) {
      const context = createCliExecutionContext({
        ...options,
        io,
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
