import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';

import { ClaudeAdapter } from '../adapters/claude.js';
import { CodexAdapter } from '../adapters/codex.js';
import {
  createFileDebugLogger,
  createNoopDebugLogger,
} from '../output/debug-log.js';
import type {
  CommandEvent,
  CommandNotice,
  CommandReporter,
  DebugLogger,
} from '../output/model.js';
import {
  createIoReporter,
  createNoopReporter,
} from '../output/reporter.js';
import type { NativeCliInvocation, NativeCliResult, NativeCliRunner } from '../utils/native-cli.js';
import { NativeCliError, execFileNativeCliRunner } from '../utils/native-cli.js';
import { resolveAwHome } from '../utils/paths.js';
import type { PlatformAdapter, PlatformName } from '../types.js';

export type {
  CommandEvent,
  CommandNotice,
  CommandReporter,
  DebugLogger,
  OutputLevel,
  OutputTarget,
} from '../output/model.js';

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export interface CommandDiagnostics {
  verbose: boolean;
  debug: boolean;
  commandName: string;
  runId: string;
  logFile?: string;
  logFileSource?: 'default' | 'explicit';
}

export interface CommandDiagnosticsInput {
  verbose?: boolean;
  debug?: boolean;
  logFile?: string;
  logFileSource?: 'default' | 'explicit';
  commandName?: string;
  runId?: string;
}

export interface CliPromptChoice {
  value: string;
  label: string;
  disabled?: boolean | string;
}

export interface CliPromptCandidate {
  id: string;
  pluginName: string;
  platform?: string;
  scope?: string;
  projectKey?: string;
  executionCwd?: string;
  selectable: boolean;
  disabledReason?: string;
  compatiblePlatforms?: string[];
}

export interface CliPrompt {
  select?: (options: {
    message: string;
    choices: CliPromptChoice[];
    defaultValue?: string;
  }) => Promise<string>;
  multiSelect?: (options: {
    message: string;
    choices: CliPromptChoice[];
    defaultValues?: string[];
  }) => Promise<string[]>;
  confirm?: (options: { message: string; defaultValue?: boolean }) => Promise<boolean>;
  selectPlatform?: (options: {
    available: string[];
    defaultValue?: string;
    message?: string;
  }) => Promise<string>;
  selectScope?: (options: {
    defaultValue?: 'user' | 'project';
  }) => Promise<'user' | 'project' | string>;
  selectPlugins?: (options: {
    command: 'install' | 'uninstall' | 'upgrade';
    candidates: CliPromptCandidate[];
    defaultValues?: string[];
    allowMultiple: boolean;
  }) => Promise<string[]>;
  selectUpgradeMode?: (options: {
    canUpgradeAll: boolean;
    candidates: CliPromptCandidate[];
  }) => Promise<'all' | 'select' | string>;
  selectSkillTrigger?: (options: {
    defaultValue?: 'default' | 'manual' | 'auto';
    allowSkip?: boolean;
  }) => Promise<'default' | 'manual' | 'auto' | 'skip' | string>;
}

export type AdaptersFactory = (
  cwd: string,
  context: CommandExecutionContext,
) => Record<PlatformName, PlatformAdapter>;

export interface CommandExecutionContext {
  env: NodeJS.ProcessEnv;
  adapters?: Record<PlatformName, PlatformAdapter>;
  adaptersFactory: AdaptersFactory;
  nativeCliRunner: NativeCliRunner;
  interactive: boolean;
  prompt: CliPrompt;
  reporter: CommandReporter;
  debugLogger: DebugLogger;
  diagnostics: CommandDiagnostics;
}

export type CommandExecutionContextInput =
  Partial<Omit<CommandExecutionContext, 'diagnostics'>> & {
    diagnostics?: CommandDiagnosticsInput | CommandDiagnostics;
  };

export interface CliExecutionContext extends CommandExecutionContext {
  cwd: string;
  io: CliIo;
  isTty: boolean;
  isCi: boolean;
}

export interface CliExecutionContextInput extends CommandExecutionContextInput {
  cwd?: string;
  io?: Partial<CliIo>;
}

function createDefaultIo(): CliIo {
  return {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  };
}

function isTruthy(value: string | undefined): boolean {
  return value === '1' || value === 'true' || value === 'yes';
}

function createRunId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function createTimestampForPath(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function defaultLogFile(commandName: string, env: NodeJS.ProcessEnv): string {
  const fileName = `aw-${createTimestampForPath()}-${commandName}.log`;
  if (commandName === 'status') {
    return path.join(os.tmpdir(), 'agent-workflows', fileName);
  }

  return path.join(resolveAwHome(env), 'logs', fileName);
}

export function createCommandDiagnostics(
  input: CommandDiagnosticsInput = {},
  env: NodeJS.ProcessEnv = process.env,
): CommandDiagnostics {
  const commandName = input.commandName ?? 'command';
  const envDebug = isTruthy(env.AW_DEBUG);
  const debug = input.debug === true || envDebug;
  const hasLogFile = Boolean(input.logFile || debug);
  return {
    verbose: input.verbose === true || debug,
    debug,
    commandName,
    runId: input.runId ?? createRunId(),
    ...(hasLogFile
      ? {
          logFile: input.logFile ?? defaultLogFile(commandName, env),
          logFileSource: input.logFile ? input.logFileSource ?? 'explicit' : 'default',
        }
      : {}),
  };
}

function createUnavailablePrompt(): CliPrompt {
  const unavailable = async (): Promise<never> => {
    throw new Error('Interactive prompt is not available in this runtime.');
  };
  return {
    select: unavailable,
    multiSelect: unavailable,
    confirm: unavailable,
    selectPlatform: unavailable,
    selectScope: unavailable,
    selectPlugins: unavailable,
    selectUpgradeMode: unavailable,
    selectSkillTrigger: unavailable,
  };
}

function formatChoice(choice: CliPromptChoice, index: number, defaultValues: Set<string>): string {
  const marker = defaultValues.has(choice.value) ? ' (默认)' : '';
  const disabled = choice.disabled
    ? ` - ${typeof choice.disabled === 'string' ? choice.disabled : '不可选'}`
    : '';
  return `${index + 1}. ${choice.label}${marker}${disabled}`;
}

function parseSelectionInput(
  answer: string,
  choices: CliPromptChoice[],
  defaults: string[],
  allowMultiple: boolean,
): string[] {
  const trimmed = answer.trim();
  if (!trimmed) {
    return defaults;
  }

  const tokens = allowMultiple
    ? trimmed.split(',').map((entry) => entry.trim()).filter(Boolean)
    : [trimmed];
  const selected: string[] = [];
  for (const token of tokens) {
    const numericIndex = Number(token);
    const choice = Number.isInteger(numericIndex)
      ? choices[numericIndex - 1]
      : choices.find((entry) => entry.value === token);
    if (!choice) {
      throw new Error(`无效选择：${token}`);
    }
    if (choice.disabled) {
      throw new Error(`不可选择 ${choice.label}：${typeof choice.disabled === 'string' ? choice.disabled : '已禁用'}`);
    }
    selected.push(choice.value);
  }

  return [...new Set(selected)];
}

function createReadlinePrompt(): CliPrompt {
  async function ask(message: string): Promise<string> {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      return await rl.question(message);
    } finally {
      rl.close();
    }
  }

  const select: NonNullable<CliPrompt['select']> = async ({ message, choices, defaultValue }) => {
    const enabledChoices = choices.filter((choice) => !choice.disabled);
    if (enabledChoices.length === 0) {
      throw new Error('没有可选择的候选项。');
    }
    const defaultValues = [defaultValue ?? enabledChoices[0].value];
    const body = choices
      .map((choice, index) => formatChoice(choice, index, new Set(defaultValues)))
      .join('\n');
    const selected = parseSelectionInput(
      await ask(`${message}\n${body}\n选择编号：`),
      choices,
      defaultValues,
      false,
    );
    return selected[0];
  };

  const multiSelect: NonNullable<CliPrompt['multiSelect']> = async ({
    message,
    choices,
    defaultValues,
  }) => {
    const enabledChoices = choices.filter((choice) => !choice.disabled);
    if (enabledChoices.length === 0) {
      throw new Error('没有可选择的候选项。');
    }
    const defaults = defaultValues && defaultValues.length > 0
      ? defaultValues
      : [enabledChoices[0].value];
    const body = choices
      .map((choice, index) => formatChoice(choice, index, new Set(defaults)))
      .join('\n');
    return parseSelectionInput(
      await ask(`${message}\n${body}\n选择编号，可用逗号分隔多个：`),
      choices,
      defaults,
      true,
    );
  };

  return {
    select,
    multiSelect,
    confirm: async ({ message, defaultValue = true }) => {
      const suffix = defaultValue ? 'Y/n' : 'y/N';
      const answer = (await ask(`${message} [${suffix}] `)).trim().toLowerCase();
      if (!answer) {
        return defaultValue;
      }
      return answer === 'y' || answer === 'yes';
    },
    selectPlatform: async ({ available, defaultValue, message }) =>
      select({
        message: message ?? '选择目标平台',
        choices: available.map((value) => ({
          value,
          label: value === 'both' ? 'Codex + Claude Code' : value === 'codex' ? 'Codex' : 'Claude Code',
        })),
        defaultValue,
      }),
    selectScope: async ({ defaultValue = 'user' }) =>
      select({
        message: '选择安装范围',
        choices: [
          { value: 'user', label: 'user' },
          { value: 'project', label: 'project' },
        ],
        defaultValue,
      }),
    selectPlugins: async ({ command, candidates, defaultValues, allowMultiple }) => {
      const choices = candidates.map((candidate) => ({
        value: candidate.id,
        label: `${candidate.pluginName}${candidate.platform ? ` / ${candidate.platform}` : ''}${candidate.scope ? ` / ${candidate.scope}` : ''}`,
        disabled: candidate.selectable ? undefined : candidate.disabledReason ?? true,
      }));
      return allowMultiple
        ? multiSelect({
            message: `选择要${command === 'install' ? '安装' : command === 'uninstall' ? '卸载' : '升级'}的插件`,
            choices,
            defaultValues,
          })
        : [await select({
            message: `选择要${command === 'install' ? '安装' : command === 'uninstall' ? '卸载' : '升级'}的插件`,
            choices,
            defaultValue: defaultValues?.[0],
          })];
    },
    selectUpgradeMode: async ({ canUpgradeAll }) =>
      select({
        message: '选择升级方式',
        choices: [
          {
            value: 'all',
            label: '全部可升级插件',
            disabled: canUpgradeAll ? undefined : '当前存在需要显式处理的插件，不能使用全部升级',
          },
          { value: 'select', label: '手动选择插件' },
        ],
        defaultValue: canUpgradeAll ? 'all' : 'select',
      }),
    selectSkillTrigger: async ({ defaultValue = 'default', allowSkip = true }) =>
      select({
        message: '选择 skill 触发偏好',
        choices: [
          { value: 'default', label: 'default' },
          { value: 'manual', label: 'manual' },
          { value: 'auto', label: 'auto' },
          ...(allowSkip ? [{ value: 'skip', label: '跳过' }] : []),
        ],
        defaultValue,
      }),
  };
}

function defaultAdaptersFactory(
  cwd: string,
  context: CommandExecutionContext,
): Record<PlatformName, PlatformAdapter> {
  return {
    codex: new CodexAdapter(cwd, context.nativeCliRunner, context.env),
    claude: new ClaudeAdapter(cwd, context.nativeCliRunner, context.env),
  };
}

function serializeInvocation(invocation: NativeCliInvocation): Record<string, unknown> {
  return {
    command: invocation.command,
    args: invocation.args,
    cwd: invocation.cwd,
    timeoutMs: invocation.timeoutMs,
  };
}

function serializeResult(result: NativeCliResult): Record<string, unknown> {
  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function serializeNativeError(error: unknown): Record<string, unknown> {
  if (error instanceof NativeCliError) {
    const cause = error.cause as { code?: string | number; name?: string; message?: string } | undefined;
    return {
      name: error.name,
      message: error.message,
      exitCode: error.exitCode,
      stdout: error.stdout,
      stderr: error.stderr,
      causeType: cause?.name ?? (cause ? cause.constructor?.name : undefined),
      causeCode: cause?.code,
      causeMessage: cause?.message,
    };
  }

  return {
    name: error instanceof Error ? error.name : typeof error,
    message: error instanceof Error ? error.message : String(error),
  };
}

function createInstrumentedNativeCliRunner(options: {
  baseRunner: NativeCliRunner;
  diagnostics: CommandDiagnostics;
  reporter: CommandReporter;
  debugLogger: DebugLogger;
}): NativeCliRunner {
  return async (invocation) => {
    const startedAt = Date.now();
    await emitRuntimeEvent(options, {
      type: 'native:start',
      commandName: options.diagnostics.commandName,
      data: {
        invocation: serializeInvocation(invocation),
      },
    });

    try {
      const result = await options.baseRunner(invocation);
      await emitRuntimeEvent(options, {
        type: 'native:success',
        commandName: options.diagnostics.commandName,
        data: {
          invocation: serializeInvocation(invocation),
          result: serializeResult(result),
          durationMs: Date.now() - startedAt,
        },
      });
      return result;
    } catch (error) {
      await emitRuntimeEvent(options, {
        type: 'native:error',
        commandName: options.diagnostics.commandName,
        message: error instanceof Error ? error.message : String(error),
        data: {
          invocation: serializeInvocation(invocation),
          error: serializeNativeError(error),
          durationMs: Date.now() - startedAt,
        },
      });
      throw error;
    }
  };
}

async function emitRuntimeEvent(
  runtime: Pick<CommandExecutionContext, 'reporter' | 'debugLogger'>,
  event: CommandEvent,
): Promise<void> {
  await runtime.reporter.event(event);
  await runtime.debugLogger.log(event);
}

export async function emitCommandEvent(
  context: CommandExecutionContext,
  event: CommandEvent,
): Promise<void> {
  await emitRuntimeEvent(context, {
    commandName: context.diagnostics.commandName,
    ...event,
  });
}

export async function emitCommandNotice(
  context: CommandExecutionContext,
  notice: CommandNotice,
): Promise<void> {
  await context.reporter.notice(notice);
  await context.debugLogger.log({
    type: `notice:${notice.level}`,
    commandName: context.diagnostics.commandName,
    message: notice.message,
    data: notice.identity ? { identity: notice.identity } : undefined,
  });
}

export function isCommandExecutionContext(
  input: CommandExecutionContextInput | undefined,
): input is CommandExecutionContext {
  return Boolean(
    input &&
      typeof input.env === 'object' &&
      typeof input.adaptersFactory === 'function' &&
      typeof input.nativeCliRunner === 'function' &&
      typeof input.reporter?.event === 'function' &&
      typeof input.debugLogger?.log === 'function' &&
      typeof input.diagnostics?.commandName === 'string',
  );
}

export function createCommandExecutionContext(
  input: CommandExecutionContextInput = {},
): CommandExecutionContext {
  if (isCommandExecutionContext(input)) {
    return input;
  }

  const env = input.env ?? process.env;
  const diagnostics = createCommandDiagnostics(input.diagnostics, env);
  const reporter = input.reporter ?? createNoopReporter();
  const debugLogger = input.debugLogger ?? createFileDebugLogger(diagnostics);
  const baseRunner = input.nativeCliRunner ?? execFileNativeCliRunner;
  const contextShell: Pick<CommandExecutionContext, 'reporter' | 'debugLogger'> = {
    reporter,
    debugLogger,
  };

  return {
    env,
    adapters: input.adapters,
    adaptersFactory: input.adaptersFactory ?? defaultAdaptersFactory,
    nativeCliRunner: createInstrumentedNativeCliRunner({
      baseRunner,
      diagnostics,
      ...contextShell,
    }),
    interactive: input.interactive ?? false,
    prompt: input.prompt ?? createUnavailablePrompt(),
    reporter,
    debugLogger,
    diagnostics,
  };
}

export function createCliExecutionContext(
  input: CliExecutionContextInput = {},
): CliExecutionContext {
  const cwd = input.cwd ?? process.cwd();
  const env = input.env ?? process.env;
  const io = {
    ...createDefaultIo(),
    ...input.io,
  };
  const diagnostics = createCommandDiagnostics(input.diagnostics, env);
  const isTty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const isCi = isTruthy(env.CI);
  const reporter = input.reporter ?? createIoReporter(io, diagnostics);
  const debugLogger = input.debugLogger ?? createFileDebugLogger(diagnostics);
  const requestedInteractive = input.interactive ?? (input.prompt ? true : isTty);
  const prompt = input.prompt ?? createReadlinePrompt();
  const commandContext = createCommandExecutionContext({
    ...input,
    env,
    interactive: requestedInteractive && !isCi,
    prompt,
    reporter,
    debugLogger,
    diagnostics,
  });

  return {
    ...commandContext,
    cwd,
    io,
    isTty,
    isCi,
  };
}
