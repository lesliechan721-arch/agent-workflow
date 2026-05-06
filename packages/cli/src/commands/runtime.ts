import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';

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
import type { Scope } from '../types.js';

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
  metadata?: Record<string, unknown>;
}

export interface CommandDiagnosticsInput {
  verbose?: boolean;
  debug?: boolean;
  logFile?: string;
  logFileSource?: 'default' | 'explicit';
  commandName?: string;
  runId?: string;
  metadata?: Record<string, unknown>;
}

export interface CliPromptChoice {
  value: string;
  label: string;
  description?: string;
  short?: string;
  disabled?: boolean | string;
}

export interface CliPromptResult<T> {
  cancelled: boolean;
  value?: T;
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

export type CliConfigPromptScope = Scope;
export type CliConfigPromptValue = string | number | boolean;
export type CliConfigPromptValueType = 'string' | 'number' | 'boolean' | 'file' | 'directory';

export interface CliConfigPromptSchemaEntry {
  type: CliConfigPromptValueType;
  label?: string;
  description?: string;
  required?: boolean;
  sensitive?: boolean;
  default?: CliConfigPromptValue;
  enum?: CliConfigPromptValue[];
  min?: number;
  max?: number;
}

export type CliConfigPromptSchema = Record<string, CliConfigPromptSchemaEntry>;

export interface CliConfigPromptOptions {
  pluginName: string;
  schema: CliConfigPromptSchema;
  initialScope: CliConfigPromptScope;
  allowedScopes: CliConfigPromptScope[];
  currentValues?: Record<string, CliConfigPromptValue | undefined>;
  configuredKeys?: string[];
  requiredKeys?: string[];
}

export interface CliConfigPromptResult {
  selectedScope: CliConfigPromptScope;
  updates: Record<string, CliConfigPromptValue>;
  updatedKeys: string[];
  removeKeys?: string[];
  cancelled?: boolean;
}

export interface CliPrompt {
  select?: (options: {
    message: string;
    choices: CliPromptChoice[];
    defaultValue?: string;
    pageSize?: number;
  }) => Promise<CliPromptResult<string>>;
  multiSelect?: (options: {
    message: string;
    choices: CliPromptChoice[];
    defaultValues?: string[];
    pageSize?: number;
  }) => Promise<CliPromptResult<string[]>>;
  confirm?: (options: {
    message: string;
    defaultValue?: boolean;
  }) => Promise<CliPromptResult<boolean>>;
  input?: (options: {
    message: string;
    defaultValue?: string;
  }) => Promise<CliPromptResult<string>>;
  password?: (options: {
    message: string;
    mask?: boolean;
  }) => Promise<CliPromptResult<string>>;
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
  configurePlugin?: (options: CliConfigPromptOptions) => Promise<CliConfigPromptResult>;
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
  consoleDriver: CliConsoleDriver;
}

export interface CliExecutionContextInput extends CommandExecutionContextInput {
  cwd?: string;
  io?: Partial<CliIo>;
  stdin?: NodeJS.ReadableStream;
  stdout?: { isTTY?: boolean };
  promptOutputSink?: CliPromptOutputSink;
  consoleDriver?: CliConsoleDriver;
}

export interface CliPromptOutputSink {
  write: (text: string) => unknown;
  isTTY?: boolean;
}

export interface CliConsoleView {
  title: string;
  lines: string[];
}

export interface CliConsoleDriver {
  render: (view: CliConsoleView) => unknown | Promise<unknown>;
}

function createDefaultIo(): CliIo {
  return {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  };
}

function createDefaultConsoleDriver(io: CliIo): CliConsoleDriver {
  return {
    render: ({ title, lines }) => {
      io.stderr(['', `== ${title} ==`, ...lines, ''].join('\n'));
    },
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
    metadata: input.metadata,
    ...(hasLogFile
      ? {
          logFile: input.logFile ?? defaultLogFile(commandName, env),
          logFileSource: input.logFile ? input.logFileSource ?? 'explicit' : 'default',
        }
      : {}),
  };
}

export function validateCliConfigPromptResult(
  options: Pick<CliConfigPromptOptions, 'allowedScopes' | 'schema'>,
  result: CliConfigPromptResult,
): CliConfigPromptResult {
  if (!options.allowedScopes.includes(result.selectedScope)) {
    throw new Error(
      `Unsupported config scope "${result.selectedScope}". Expected one of: ${options.allowedScopes.join(', ')}.`,
    );
  }

  const schemaKeys = new Set(Object.keys(options.schema));
  const updateKeys = Object.keys(result.updates);
  const removeKeys = result.removeKeys ?? [];
  for (const key of [...result.updatedKeys, ...updateKeys, ...removeKeys]) {
    if (!schemaKeys.has(key)) {
      throw new Error(`Unsupported config key "${key}".`);
    }
  }

  const updatedKeySet = new Set(result.updatedKeys);
  for (const key of updateKeys) {
    if (!updatedKeySet.has(key)) {
      throw new Error(`Config prompt result update "${key}" is missing from updatedKeys.`);
    }
  }
  for (const key of result.updatedKeys) {
    if (!Object.hasOwn(result.updates, key)) {
      throw new Error(`Config prompt result updatedKeys contains "${key}" without an update value.`);
    }
  }
  for (const key of removeKeys) {
    if (Object.hasOwn(result.updates, key)) {
      throw new Error(`Config prompt result cannot update and remove "${key}" in the same submission.`);
    }
  }

  return result;
}

function createUnavailablePrompt(): CliPrompt {
  const unavailable = async (): Promise<never> => {
    throw new Error('Interactive prompt is not available in this runtime.');
  };
  return {
    select: unavailable,
    multiSelect: unavailable,
    confirm: unavailable,
    input: unavailable,
    password: unavailable,
    selectPlatform: unavailable,
    selectScope: unavailable,
    selectPlugins: unavailable,
    selectUpgradeMode: unavailable,
    selectSkillTrigger: unavailable,
    configurePlugin: unavailable,
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

function createPromptWritable(outputSink: CliPromptOutputSink): NodeJS.WritableStream {
  const writable = new Writable({
    write(chunk, _encoding, callback) {
      outputSink.write(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      callback();
    },
  }) as NodeJS.WritableStream & { isTTY?: boolean };
  writable.isTTY = outputSink.isTTY;
  return writable;
}

function createPromptResult<T>(value: T): CliPromptResult<T> {
  return {
    cancelled: false,
    value,
  };
}

function createCancelledPromptResult<T>(): CliPromptResult<T> {
  return {
    cancelled: true,
  };
}

function unwrapPromptResult<T>(
  result: CliPromptResult<T>,
  message = 'Interactive prompt cancelled.',
): T {
  if (result.cancelled || result.value === undefined) {
    throw new Error(message);
  }
  return result.value;
}

function isPromptCancellationError(error: unknown): boolean {
  return error instanceof Error &&
    (error.name === 'ExitPromptError' || error.name === 'AbortPromptError');
}

interface InquirerPromptContext {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  clearPromptOnDone?: boolean;
}

interface InquirerPromptModule {
  select: (options: {
    message: string;
    choices: Array<{
      name: string;
      value: string;
      description?: string;
      short?: string;
      disabled?: boolean | string;
    }>;
    default?: string;
    pageSize?: number;
    loop?: boolean;
  }, context?: InquirerPromptContext) => Promise<string>;
  confirm: (options: {
    message: string;
    default?: boolean;
  }, context?: InquirerPromptContext) => Promise<boolean>;
  input: (options: {
    message: string;
    default?: string;
  }, context?: InquirerPromptContext) => Promise<string>;
  password: (options: {
    message: string;
    mask?: boolean;
  }, context?: InquirerPromptContext) => Promise<string>;
}

let inquirerPromptModulePromise: Promise<InquirerPromptModule> | null = null;

async function loadInquirerPromptModule(): Promise<InquirerPromptModule> {
  if (!inquirerPromptModulePromise) {
    const moduleName = '@inquirer/prompts';
    inquirerPromptModulePromise = import(moduleName) as Promise<InquirerPromptModule>;
  }
  return inquirerPromptModulePromise;
}

function shouldPromptConfigKey(
  key: string,
  definition: CliConfigPromptSchemaEntry,
  options: CliConfigPromptOptions,
): boolean {
  const currentValue = options.currentValues?.[key];
  const configured = currentValue !== undefined || options.configuredKeys?.includes(key) === true;
  return Boolean(
    definition.required ||
      options.requiredKeys?.includes(key) ||
      !configured,
  );
}

function formatConfigKeyChoiceLabel(
  key: string,
  definition: CliConfigPromptSchemaEntry,
  options: CliConfigPromptOptions,
): string {
  const label = definition.label ?? key;
  const currentValue = options.currentValues?.[key];
  const configured = currentValue !== undefined || options.configuredKeys?.includes(key) === true;
  if (!configured) {
    return label;
  }
  if (definition.sensitive) {
    return `${label}（当前：已配置）`;
  }
  return `${label}（当前：${String(currentValue)}）`;
}

function parsePromptedConfigValue(
  key: string,
  definition: CliConfigPromptSchemaEntry,
  answer: string,
): CliConfigPromptValue | undefined {
  const trimmed = answer.trim();
  if (!trimmed) {
    return undefined;
  }

  if (definition.type === 'number') {
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) {
      throw new Error(`配置项 ${key} 需要数字。`);
    }
    return parsed;
  }

  if (definition.type === 'boolean') {
    const normalized = trimmed.toLowerCase();
    if (['true', '1', 'yes', 'y'].includes(normalized)) {
      return true;
    }
    if (['false', '0', 'no', 'n'].includes(normalized)) {
      return false;
    }
    throw new Error(`配置项 ${key} 需要布尔值。`);
  }

  return answer;
}

export interface ReadlinePromptOptions {
  input?: NodeJS.ReadableStream;
  outputSink?: CliPromptOutputSink;
}

export function createReadlinePrompt(options: ReadlinePromptOptions = {}): CliPrompt {
  const input = options.input ?? process.stdin;
  const outputSink = options.outputSink ?? process.stderr;
  const output = createPromptWritable(outputSink);

  async function ask(message: string, askOptions: { hidden?: boolean } = {}): Promise<string> {
    if (askOptions.hidden) {
      outputSink.write(message);
      const mutedOutput = new Writable({
        write(_chunk, _encoding, callback) {
          callback();
        },
      }) as NodeJS.WritableStream & { isTTY?: boolean };
      mutedOutput.isTTY = outputSink.isTTY;
      const rl = createInterface({
        input,
        output: mutedOutput,
        terminal: Boolean((input as { isTTY?: boolean }).isTTY && outputSink.isTTY),
      });
      try {
        const answer = await rl.question('');
        outputSink.write('\n');
        return answer;
      } finally {
        rl.close();
      }
    }

    const rl = createInterface({
      input,
      output,
      terminal: Boolean((input as { isTTY?: boolean }).isTTY && outputSink.isTTY),
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
    return createPromptResult(selected[0]);
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
    return createPromptResult(parseSelectionInput(
      await ask(`${message}\n${body}\n选择编号，可用逗号分隔多个：`),
      choices,
      defaults,
      true,
    ));
  };

  const confirm: NonNullable<CliPrompt['confirm']> = async ({ message, defaultValue = true }) => {
    const suffix = defaultValue ? 'Y/n' : 'y/N';
    const answer = (await ask(`${message} [${suffix}] `)).trim().toLowerCase();
    if (!answer) {
      return createPromptResult(defaultValue);
    }
    return createPromptResult(answer === 'y' || answer === 'yes');
  };

  const inputPrompt: NonNullable<CliPrompt['input']> = async ({ message, defaultValue }) => {
    const answer = await ask(defaultValue === undefined
      ? `${message}: `
      : `${message}（默认：${defaultValue}）: `);
    return createPromptResult(answer.trim() === '' && defaultValue !== undefined ? defaultValue : answer);
  };

  const passwordPrompt: NonNullable<CliPrompt['password']> = async ({ message }) => {
    const answer = await ask(`${message}: `, { hidden: true });
    return createPromptResult(answer);
  };

  return {
    select,
    multiSelect,
    confirm,
    input: inputPrompt,
    password: passwordPrompt,
    selectPlatform: async ({ available, defaultValue, message }) =>
      unwrapPromptResult(await select({
        message: message ?? '选择目标平台',
        choices: available.map((value) => ({
          value,
          label: value === 'both' ? 'Codex + Claude Code' : value === 'codex' ? 'Codex' : 'Claude Code',
        })),
        defaultValue,
      })),
    selectScope: async ({ defaultValue = 'user' }) =>
      unwrapPromptResult(await select({
        message: '选择安装范围',
        choices: [
          { value: 'user', label: 'user' },
          { value: 'project', label: 'project' },
        ],
        defaultValue,
      })),
    selectPlugins: async ({ command, candidates, defaultValues, allowMultiple }) => {
      const choices = candidates.map((candidate) => ({
        value: candidate.id,
        label: `${candidate.pluginName}${candidate.platform ? ` / ${candidate.platform}` : ''}${candidate.scope ? ` / ${candidate.scope}` : ''}`,
        disabled: candidate.selectable ? undefined : candidate.disabledReason ?? true,
      }));
      return allowMultiple
        ? unwrapPromptResult(await multiSelect({
            message: `选择要${command === 'install' ? '安装' : command === 'uninstall' ? '卸载' : '升级'}的插件`,
            choices,
            defaultValues,
          }))
        : [unwrapPromptResult(await select({
            message: `选择要${command === 'install' ? '安装' : command === 'uninstall' ? '卸载' : '升级'}的插件`,
            choices,
            defaultValue: defaultValues?.[0],
          }))];
    },
    selectUpgradeMode: async ({ canUpgradeAll }) =>
      unwrapPromptResult(await select({
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
      })),
    selectSkillTrigger: async ({ defaultValue = 'default', allowSkip = true }) =>
      unwrapPromptResult(await select({
        message: '选择 skill 触发偏好',
        choices: [
          { value: 'default', label: 'default' },
          { value: 'manual', label: 'manual' },
          { value: 'auto', label: 'auto' },
          ...(allowSkip ? [{ value: 'skip', label: '跳过' }] : []),
        ],
        defaultValue,
      })),
    configurePlugin: async (configOptions) => {
      const selectedScope = configOptions.allowedScopes.length > 1
        ? unwrapPromptResult(await select({
            message: `选择 ${configOptions.pluginName} 配置写入范围`,
            choices: configOptions.allowedScopes.map((value) => ({ value, label: value })),
            defaultValue: configOptions.initialScope,
          })) as CliConfigPromptScope
        : configOptions.initialScope;
      const updates: Record<string, CliConfigPromptValue> = {};
      const removeKeys: string[] = [];
      const keysToPrompt = new Set<string>();
      const optionalConfiguredChoices: CliPromptChoice[] = [];

      for (const [key, definition] of Object.entries(configOptions.schema)) {
        if (shouldPromptConfigKey(key, definition, configOptions)) {
          keysToPrompt.add(key);
          continue;
        }

        optionalConfiguredChoices.push({
          value: key,
          label: formatConfigKeyChoiceLabel(key, definition, configOptions),
        });
      }

      if (optionalConfiguredChoices.length > 0) {
        const body = optionalConfiguredChoices
          .map((choice, index) => formatChoice(choice, index, new Set<string>()))
          .join('\n');
        const selectedKeys = parseSelectionInput(
          await ask(
            `选择要更新的 ${configOptions.pluginName} 配置项\n${body}\n选择编号，可用逗号分隔多个，直接回车跳过：`,
          ),
          optionalConfiguredChoices,
          [],
          true,
        );
        for (const key of selectedKeys) {
          keysToPrompt.add(key);
        }
      }

      for (const [key, definition] of Object.entries(configOptions.schema)) {
        if (!keysToPrompt.has(key)) {
          continue;
        }

        const label = definition.label ?? key;
        if (definition.enum && definition.enum.length > 0) {
          const selected = unwrapPromptResult(await select({
            message: label,
            choices: definition.enum.map((value) => ({
              value: String(value),
              label: String(value),
            })),
            defaultValue: configOptions.currentValues?.[key] === undefined
              ? undefined
              : String(configOptions.currentValues[key]),
          }));
          updates[key] = selected;
          continue;
        }

        if (definition.type === 'boolean') {
          updates[key] = await (async () => {
            const current = configOptions.currentValues?.[key];
            return unwrapPromptResult(
              current === undefined
                ? await confirm({ message: label, defaultValue: Boolean(definition.default) })
                : await confirm({ message: label, defaultValue: Boolean(current) }),
            );
          })();
          continue;
        }

        const current = configOptions.currentValues?.[key];
        const configured = current !== undefined || configOptions.configuredKeys?.includes(key) === true;
        const suffix = !configured || definition.sensitive
          ? definition.sensitive && configured
            ? '（当前：已配置）'
            : ''
          : `（当前：${String(current)}）`;
        const answer = await ask(`${label}${suffix}: `, {
          hidden: definition.sensitive && definition.type === 'string',
        });
        const parsed = parsePromptedConfigValue(key, definition, answer);
        if (parsed !== undefined) {
          updates[key] = parsed;
        } else if (!definition.required && configured) {
          removeKeys.push(key);
        }
      }

      const result: CliConfigPromptResult = {
        selectedScope,
        updates,
        updatedKeys: Object.keys(updates),
        removeKeys,
        cancelled: false,
      };
      return validateCliConfigPromptResult(configOptions, result);
    },
  };
}

interface InquirerPromptOptions extends ReadlinePromptOptions {
  fallback?: CliPrompt;
}

async function runPromptWithFallback<T>(options: {
  run: (module: InquirerPromptModule, context: InquirerPromptContext) => Promise<T>;
  fallback?: () => Promise<CliPromptResult<T>>;
  input: NodeJS.ReadableStream;
  outputSink: CliPromptOutputSink;
}): Promise<CliPromptResult<T>> {
  try {
    const module = await loadInquirerPromptModule();
    const output = createPromptWritable(options.outputSink);
    const value = await options.run(module, {
      input: options.input,
      output,
      clearPromptOnDone: true,
    });
    return createPromptResult(value);
  } catch (error) {
    if (isPromptCancellationError(error)) {
      return createCancelledPromptResult();
    }
    if (options.fallback) {
      return options.fallback();
    }
    throw error;
  }
}

export function createInquirerPrompt(options: InquirerPromptOptions = {}): CliPrompt {
  const input = options.input ?? process.stdin;
  const outputSink = options.outputSink ?? process.stderr;
  const fallback = options.fallback;

  return {
    select: async ({ message, choices, defaultValue, pageSize }) =>
      runPromptWithFallback({
        input,
        outputSink,
        fallback: fallback?.select
          ? () => fallback.select!({ message, choices, defaultValue, pageSize })
          : undefined,
        run: (module, context) => module.select({
          message,
          choices: choices.map((choice) => ({
            name: choice.label,
            value: choice.value,
            description: choice.description,
            short: choice.short,
            disabled: choice.disabled,
          })),
          default: defaultValue,
          pageSize,
          loop: false,
        }, context),
      }),
    multiSelect: async ({ message, choices, defaultValues, pageSize }) =>
      fallback?.multiSelect
        ? fallback.multiSelect({ message, choices, defaultValues, pageSize })
        : createCancelledPromptResult(),
    confirm: async ({ message, defaultValue }) =>
      runPromptWithFallback({
        input,
        outputSink,
        fallback: fallback?.confirm
          ? () => fallback.confirm!({ message, defaultValue })
          : undefined,
        run: (module, context) => module.confirm({
          message,
          default: defaultValue,
        }, context),
      }),
    input: async ({ message, defaultValue }) =>
      runPromptWithFallback({
        input,
        outputSink,
        fallback: fallback?.input
          ? () => fallback.input!({ message, defaultValue })
          : undefined,
        run: (module, context) => module.input({
          message,
          default: defaultValue,
        }, context),
      }),
    password: async ({ message, mask }) =>
      runPromptWithFallback({
        input,
        outputSink,
        fallback: fallback?.password
          ? () => fallback.password!({ message, mask })
          : undefined,
        run: (module, context) => module.password({
          message,
          mask,
        }, context),
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
  const stdin = input.stdin ?? process.stdin;
  const stdout = input.stdout ?? process.stdout;
  const promptOutputSink = input.promptOutputSink ?? process.stderr;
  const stdinIsTty = Boolean((stdin as { isTTY?: boolean }).isTTY);
  const stdoutIsTty = Boolean(stdout.isTTY);
  const promptOutputIsTty = Boolean(promptOutputSink.isTTY);
  const isTty = stdinIsTty && stdoutIsTty && promptOutputIsTty;
  const isCi = isTruthy(env.CI);
  const hasInjectedPrompt = Boolean(input.prompt);
  const requestedInteractive = input.interactive ?? (hasInjectedPrompt ? true : isTty);
  const interactive = requestedInteractive && !isCi && (isTty || hasInjectedPrompt);
  const diagnostics = createCommandDiagnostics({
    ...input.diagnostics,
    metadata: {
      ...input.diagnostics?.metadata,
      cwd,
      awHome: resolveAwHome(env),
      isTty,
      isCi,
      stdinIsTty,
      stdoutIsTty,
      promptOutputIsTty,
      interactiveRequested: requestedInteractive,
      interactiveEnabled: interactive,
    },
  }, env);
  const reporter = input.reporter ?? createIoReporter(io, diagnostics);
  const debugLogger = input.debugLogger ?? createFileDebugLogger(diagnostics);
  const prompt = input.prompt ?? (interactive
    ? createInquirerPrompt({
        input: stdin,
        outputSink: promptOutputSink,
        fallback: createReadlinePrompt({ input: stdin, outputSink: promptOutputSink }),
      })
    : createUnavailablePrompt());
  const consoleDriver = input.consoleDriver ?? createDefaultConsoleDriver(io);
  const commandContext = createCommandExecutionContext({
    ...input,
    env,
    interactive,
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
    consoleDriver,
  };
}
