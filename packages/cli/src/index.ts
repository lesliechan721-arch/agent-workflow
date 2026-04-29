#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Command, CommanderError } from 'commander';

import { initCommand } from './commands/init.js';
import { installCommand } from './commands/install.js';
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
  createInteractiveInstallPlan,
  createInteractiveUninstallPlan,
  createInteractiveUpgradePlan,
} from './commands/interactive.js';
import {
  normalizeCommandOptions,
  normalizeInstallCommandOptions,
  normalizeStatusCommandOptions,
  normalizeUpgradeCommandOptions,
  parseSkillTriggerPreference,
} from './commands/options.js';
import {
  CommandWarningError,
  isCommandWarningError,
  type NativePluginsByPlatform,
} from './types.js';
import { formatWarnings } from './output/reporter.js';
import { resolveAwHome } from './utils/paths.js';

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

function writeWarnings(write: (text: string) => void, warnings: string[]): void {
  for (const warning of formatWarnings(warnings)) {
    writeLine(write, warning);
  }
}

function mergeCommandResults(
  results: Array<{ platforms: string[]; plugins: string[]; warnings: string[]; nativePlugins?: NativePluginsByPlatform }>,
): { platforms: string[]; plugins: string[]; warnings: string[]; nativePlugins: NativePluginsByPlatform } {
  const nativePlugins: NativePluginsByPlatform = {};
  for (const result of results) {
    for (const [platform, pluginNames] of Object.entries(result.nativePlugins ?? {}) as Array<[keyof NativePluginsByPlatform, string[] | undefined]>) {
      if (!pluginNames || pluginNames.length === 0) {
        continue;
      }
      nativePlugins[platform] ??= [];
      for (const pluginName of pluginNames) {
        if (!nativePlugins[platform].includes(pluginName)) {
          nativePlugins[platform].push(pluginName);
        }
      }
    }
  }

  return {
    platforms: [...new Set(results.flatMap((result) => result.platforms))],
    plugins: [...new Set(results.flatMap((result) => result.plugins))],
    warnings: results.flatMap((result) => result.warnings),
    nativePlugins,
  };
}

interface CliCommandResult {
  platforms: string[];
  plugins: string[];
  warnings: string[];
  nativePlugins?: NativePluginsByPlatform;
}

interface CliCommandReceipt {
  result: CliCommandResult;
  scopes: string[];
}

const PLATFORM_LABELS: Record<string, string> = {
  codex: 'Codex',
  claude: 'Claude Code',
};

function formatList(values: string[]): string {
  const unique = [...new Set(values)].filter(Boolean);
  return unique.length > 0 ? unique.join(', ') : '无';
}

function formatPlatforms(platforms: string[]): string {
  return formatList(platforms.map((platform) => PLATFORM_LABELS[platform] ?? platform));
}

function formatScopes(scopes: string[]): string {
  return formatList(scopes.map((scope) => `${scope} scope`));
}

function commandVerb(action: 'install' | 'uninstall' | 'upgrade'): string {
  return action === 'install' ? '已安装' : action === 'uninstall' ? '已卸载' : '已升级';
}

function commandNoun(action: 'install' | 'uninstall' | 'upgrade'): string {
  return action === 'install' ? '安装' : action === 'uninstall' ? '卸载' : '升级';
}

function writeCommandReceipt(
  write: (text: string) => void,
  action: 'install' | 'uninstall' | 'upgrade',
  receipt: CliCommandReceipt,
  context: CliExecutionContext,
): void {
  const { result, scopes } = receipt;
  const awHome = resolveAwHome(context.env);
  const firstPlugin = result.plugins[0];
  const pluginList = formatList(result.plugins);
  const platformList = formatPlatforms(result.platforms);
  const scopeList = formatScopes(scopes);

  writeLine(write, `${commandVerb(action)} ${pluginList}：${platformList} / ${scopeList}。`);

  if (action === 'install' || action === 'upgrade') {
    writeLine(write, `使用插件目录：AW marketplace。`);
    writeLine(write, `已同步本地 marketplace：${awHome}。`);
    const codexNativePlugins = result.nativePlugins?.codex ?? [];
    if (codexNativePlugins.length > 0) {
      writeLine(write, `已确认 Codex marketplace 注册：${awHome}。`);
      writeLine(write, `已确认插件启用：${codexNativePlugins.map((plugin) => `${plugin}@aw`).join(', ')}。`);
    }
    if ((result.nativePlugins?.claude ?? []).length > 0) {
      writeLine(write, `已确认 Claude Code marketplace 和插件状态。`);
    }
  } else {
    writeLine(write, '已清理匹配的受管状态和生成产物。');
  }

  const platformFlag = result.platforms.length === 1 ? ` -p ${result.platforms[0]}` : '';
  const statusTarget = firstPlugin ? ` ${firstPlugin}` : '';
  writeLine(
    write,
    `完成。下一步：运行 aw status${statusTarget}${platformFlag} 查看${commandNoun(action)}后的状态。`,
  );
}

interface RawDiagnosticsOptions {
  verbose?: boolean;
  debug?: boolean;
  logFile?: string;
  interactive?: boolean;
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

function shouldCreateInteractiveInstallPlan(
  pluginNames: string[],
  options: { platform: string; requestedSkillTrigger?: unknown },
  context: CliExecutionContext,
  forcePrompt: boolean,
): boolean {
  if (forcePrompt) {
    return true;
  }
  if (!context.interactive) {
    return false;
  }
  if (pluginNames.length === 0 || options.platform === 'auto') {
    return true;
  }

  return !options.requestedSkillTrigger &&
    typeof context.prompt.selectSkillTrigger === 'function';
}

function shouldCreateInteractiveExistingPlan(
  pluginNames: string[],
  context: CliExecutionContext,
  forcePrompt: boolean,
): boolean {
  return forcePrompt || (context.interactive && pluginNames.length === 0);
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

export function buildProgram(options: CliRuntimeOptions = {}): Command {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
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
      interactive: rawOptions.interactive ?? options.interactive,
      diagnostics: toCliDiagnosticsOptions(commandName, rawOptions, options.diagnostics),
    });

  const program = new Command();
  program
    .name('aw')
    .description('Agent workflow marketplace installer')
    .exitOverride()
    .configureOutput({
      writeOut: (text) => io.stdout(text),
      writeErr: (text) => io.stderr(text),
      outputError: (text, write) => write(text),
    });

  program
    .command('init')
    .option('-f, --force', 'refresh the local marketplace bundle', false)
    .option('-v, --verbose', 'show command diagnostics', false)
    .option('-D, --debug', 'write debug diagnostics to a log file', false)
    .option('--log-file <path>', 'write debug diagnostics to the specified file')
    .action(async (rawOptions: { force?: boolean } & RawDiagnosticsOptions) => {
      const context = createActionContext('init', rawOptions);
      const result = await runActionWithContext(context, () =>
        initCommand({ force: rawOptions.force, env: context.env }),
      );
      writeLine(
        io.stdout,
        `${result.changed ? 'Initialized' : 'Reused'} local marketplace at ${result.rootDir}.`,
      );
      writeWarnings(io.stderr, result.warnings);
    });

  program
    .command('install')
    .argument('[plugins...]')
    .option('-s, --scope <scope>', 'project or user', 'user')
    .option('-p, --platform <platform>', 'codex | claude | both | auto', 'auto')
    .option('-t, --skill-trigger <preference>', 'default | manual | auto', parseSkillTriggerPreference)
    .option('-i, --interactive', 'prompt for missing install choices')
    .option('--no-interactive', 'disable interactive prompts')
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
            await emitCommandEvent(context, {
              type: 'options:normalized',
              data: {
                plugins: plugins ?? [],
                options: commandOptions,
              },
            });
            const forcePrompt = rawOptions.interactive === true;
            const plan = shouldCreateInteractiveInstallPlan(
              plugins ?? [],
              commandOptions,
              context,
              forcePrompt,
            )
              ? await createInteractiveInstallPlan(
                  plugins ?? [],
                  commandOptions,
                  context,
                  forcePrompt,
                )
              : null;
            if (!plan) {
              return {
                result: await installCommand(plugins ?? [], commandOptions, context),
                scopes: [commandOptions.scope],
              };
            }

            const results = [];
            for (const group of plan.groups) {
              results.push(await installCommand(group.pluginNames, group.options, context));
            }
            return {
              result: mergeCommandResults(results),
              scopes: plan.groups.map((group) => group.options.scope),
            };
          },
        );
        writeCommandReceipt(io.stdout, 'install', receipt, context);
        writeWarnings(io.stderr, receipt.result.warnings);
      },
    );

  program
    .command('uninstall')
    .argument('[plugins...]')
    .option('-s, --scope <scope>', 'project or user', 'user')
    .option('-p, --platform <platform>', 'codex | claude | both | auto', 'auto')
    .option('-i, --interactive', 'prompt for missing uninstall choices')
    .option('--no-interactive', 'disable interactive prompts')
    .option('-v, --verbose', 'show command diagnostics', false)
    .option('-D, --debug', 'write debug diagnostics to a log file', false)
    .option('--log-file <path>', 'write debug diagnostics to the specified file')
    .action(async (
      plugins: string[],
      rawOptions: { scope?: string; platform?: string } & RawDiagnosticsOptions,
    ) => {
      const context = createActionContext('uninstall', rawOptions);
      const receipt = await runActionWithContext(
        context,
        async () => {
          const commandOptions = normalizeCommandOptions({
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
          const forcePrompt = rawOptions.interactive === true;
          const plan = shouldCreateInteractiveExistingPlan(
            plugins ?? [],
            context,
            forcePrompt,
          )
            ? await createInteractiveUninstallPlan(
                plugins ?? [],
                commandOptions,
                context,
                forcePrompt,
              )
            : null;
          if (!plan) {
            return {
              result: await uninstallCommand(plugins ?? [], commandOptions, context),
              scopes: [commandOptions.scope],
            };
          }

          const results = [];
          for (const group of plan.groups) {
            results.push(await uninstallCommand(group.pluginNames, group.options, context));
          }
          return {
            result: mergeCommandResults(results),
            scopes: plan.groups.map((group) => group.options.scope),
          };
        },
      );
      writeCommandReceipt(io.stdout, 'uninstall', receipt, context);
      writeWarnings(io.stderr, receipt.result.warnings);
    });

  program
    .command('upgrade')
    .argument('[plugins...]')
    .option('-a, --all', 'upgrade all plugins', false)
    .option('-s, --scope <scope>', 'project or user', 'user')
    .option('-p, --platform <platform>', 'codex | claude | both | auto', 'auto')
    .option('-t, --skill-trigger <preference>', 'default | manual | auto', parseSkillTriggerPreference)
    .option('-i, --interactive', 'prompt for missing upgrade choices')
    .option('--no-interactive', 'disable interactive prompts')
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
            await emitCommandEvent(context, {
              type: 'options:normalized',
              data: {
                plugins: plugins ?? [],
                options: commandOptions,
              },
            });
            const forcePrompt = rawOptions.interactive === true;
            const plan = shouldCreateInteractiveExistingPlan(
              plugins ?? [],
              context,
              forcePrompt,
            )
              ? await createInteractiveUpgradePlan(
                  plugins ?? [],
                  commandOptions,
                  context,
                  forcePrompt,
                )
              : null;
            if (!plan) {
              return {
                result: await upgradeCommand(plugins ?? [], commandOptions, context),
                scopes: [commandOptions.scope],
              };
            }

            const results = [];
            for (const group of plan.groups) {
              results.push(await upgradeCommand(group.pluginNames, group.options, context));
            }
            return {
              result: mergeCommandResults(results),
              scopes: plan.groups.map((group) => group.options.scope),
            };
          },
        );
        writeCommandReceipt(io.stdout, 'upgrade', receipt, context);
        writeWarnings(io.stderr, receipt.result.warnings);
      },
    );

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
    return 0;
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
