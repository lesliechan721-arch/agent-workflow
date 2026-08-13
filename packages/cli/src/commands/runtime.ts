import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';

import { createFileDebugLogger } from '../output/debug-log.js';
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
import { NativeCliError, getDefaultNativeCliRunner } from '../utils/native-cli.js';
import { resolveAwHome } from '../utils/paths.js';
import { assertTestWritablePath } from '../utils/test-path-fence.js';
import type { Scope } from '../types.js';
import { createInkPrompt } from '../tui/prompt.js';
import { createInkTuiRunner, type TuiRunner } from '../tui/runner.js';

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
  role?: 'option' | 'back' | 'exit';
}

export type CliPromptAction = 'select' | 'back' | 'exit' | 'cancel';

export interface CliPromptResult<T> {
  action: CliPromptAction;
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
  configurePlugin?: (options: CliConfigPromptOptions) => Promise<CliConfigPromptResult>;
}

export interface CommandExecutionContext {
  env: NodeJS.ProcessEnv;
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
  stdin: NodeJS.ReadableStream;
  isTty: boolean;
  isCi: boolean;
  tuiRunner: TuiRunner;
  tuiOutput: CliPromptOutputSink;
}

export interface CliExecutionContextInput extends CommandExecutionContextInput {
  cwd?: string;
  io?: Partial<CliIo>;
  stdin?: NodeJS.ReadableStream;
  stdout?: { isTTY?: boolean };
  promptOutputSink?: CliPromptOutputSink;
  tuiRunner?: TuiRunner;
}

export interface CliPromptOutputSink {
  write: (text: string) => unknown;
  isTTY?: boolean;
}

interface ReporterRoute {
  current: CommandReporter;
}

const reporterRoutes = new WeakMap<CommandReporter, ReporterRoute>();

function createSessionAwareReporter(defaultReporter: CommandReporter): CommandReporter {
  const route: ReporterRoute = { current: defaultReporter };
  const reporter: CommandReporter = {
    event: (event) => route.current.event(event),
    notice: (notice) => route.current.notice(notice),
  };
  reporterRoutes.set(reporter, route);
  return reporter;
}

export async function withCommandReporterSession<T>(
  reporter: CommandReporter,
  sessionReporter: CommandReporter,
  task: () => Promise<T>,
): Promise<T> {
  const route = reporterRoutes.get(reporter);
  if (!route) return task();
  const previous = route.current;
  route.current = sessionReporter;
  try {
    return await task();
  } finally {
    route.current = previous;
  }
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

function assertDebugLogPathForTests(
  logFile: string,
  source: 'default' | 'explicit',
  commandName: string,
): string {
  return assertTestWritablePath(
    logFile,
    source === 'explicit'
      ? '--log-file'
      : commandName === 'status'
        ? 'AW_DEBUG default status log file'
        : 'AW_DEBUG default log file',
    source === 'explicit'
      ? '用 createIsolatedTestEnv() 提供安全 cwd/TMPDIR/AW_HOME，或通过 registerWritableStateRoot() 登记 --log-file 目标路径。'
      : '用 createIsolatedTestEnv() 生成默认 TMPDIR/AW_HOME，或通过 registerWritableStateRoot() 登记调试日志目录。',
  );
}

function defaultLogFile(commandName: string, env: NodeJS.ProcessEnv): string {
  const fileName = `aw-${createTimestampForPath()}-${commandName}.log`;
  if (commandName === 'status') {
    return assertDebugLogPathForTests(
      path.join(os.tmpdir(), 'agent-workflows', fileName),
      'default',
      commandName,
    );
  }

  return assertDebugLogPathForTests(
    path.join(resolveAwHome(env), 'logs', fileName),
    'default',
    commandName,
  );
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
          logFile: input.logFile
            ? assertDebugLogPathForTests(input.logFile, 'explicit', commandName)
            : defaultLogFile(commandName, env),
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
    action: 'select',
    cancelled: false,
    value,
  };
}

function createPromptActionResult<T>(action: Exclude<CliPromptAction, 'select'>): CliPromptResult<T> {
  return {
    action,
    cancelled: action === 'cancel',
  };
}

function unwrapPromptResult<T>(
  result: CliPromptResult<T>,
  message = 'Interactive prompt cancelled.',
): T {
  if (result.action !== 'select' || result.value === undefined) {
    throw new Error(message);
  }
  return result.value;
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

type PromptInteractionMode = 'menu' | 'confirm' | 'text';

interface PromptInteractionOptions {
  allowBack?: boolean;
  allowExit?: boolean;
  mode?: PromptInteractionMode;
}

function normalizePromptInput(value: string): string {
  return value.trim();
}

function resolveTypedPromptAction(
  answer: string,
  options: PromptInteractionOptions = {},
): Exclude<CliPromptAction, 'select'> | null {
  const mode = options.mode ?? 'text';
  const normalized = normalizePromptInput(answer);

  if (normalized === '\u0003') {
    return 'exit';
  }

  if (normalized === '\u001B') {
    if (mode === 'menu') {
      return options.allowBack ? 'back' : 'exit';
    }
    return 'cancel';
  }

  if (mode !== 'menu') {
    return null;
  }

  if (options.allowBack && ['b', 'B'].includes(normalized)) {
    return 'back';
  }
  if ((options.allowExit ?? true) && ['q', 'Q'].includes(normalized)) {
    return 'exit';
  }

  return null;
}

function resolveChoiceResult(
  value: string,
  choices: CliPromptChoice[],
): CliPromptResult<string> {
  const choice = choices.find((entry) => entry.value === value);
  if (choice?.role === 'back') {
    return createPromptActionResult('back');
  }
  if (choice?.role === 'exit') {
    return createPromptActionResult('exit');
  }
  return createPromptResult(value);
}

function createMutedOutput(outputSink: CliPromptOutputSink): NodeJS.WritableStream {
  const mutedOutput = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  }) as NodeJS.WritableStream & { isTTY?: boolean };
  mutedOutput.isTTY = outputSink.isTTY;
  return mutedOutput;
}

export interface ReadlinePromptOptions {
  input?: NodeJS.ReadableStream;
  outputSink?: CliPromptOutputSink;
}

export function createReadlinePrompt(options: ReadlinePromptOptions = {}): CliPrompt {
  const input = options.input ?? process.stdin;
  const outputSink = options.outputSink ?? process.stderr;
  const output = createPromptWritable(outputSink);

  async function ask(
    message: string,
    askOptions: { hidden?: boolean } & PromptInteractionOptions = {},
  ): Promise<CliPromptResult<string>> {
    const hidden = askOptions.hidden === true;
    if (hidden) {
      outputSink.write(message);
    }
    const rl = createInterface({
      input,
      output: hidden ? createMutedOutput(outputSink) : output,
      terminal: Boolean((input as { isTTY?: boolean }).isTTY && outputSink.isTTY),
    });
    const promptText = hidden ? '' : message;
    try {
      const result = await new Promise<CliPromptResult<string>>((resolve, reject) => {
        const handleSigint = () => {
          resolve(createPromptActionResult('exit'));
        };
        rl.once('SIGINT', handleSigint);
        rl.question(promptText)
          .then((answer) => {
            const action = resolveTypedPromptAction(answer, askOptions);
            resolve(action ? createPromptActionResult(action) : createPromptResult(answer));
          })
          .catch(reject)
          .finally(() => {
            rl.off('SIGINT', handleSigint);
          });
      });
      if (hidden) {
        outputSink.write('\n');
      }
      return result;
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
    const answer = await ask(`${message}\n${body}\n选择编号：`, {
      mode: 'menu',
      allowBack: choices.some((choice) => choice.role === 'back'),
      allowExit: true,
    });
    if (answer.action !== 'select') {
      return answer;
    }
    const selected = parseSelectionInput(
      answer.value!,
      choices,
      defaultValues,
      false,
    );
    return resolveChoiceResult(selected[0], choices);
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
    const answer = await ask(`${message}\n${body}\n选择编号，可用逗号分隔多个：`, {
      mode: 'menu',
      allowBack: choices.some((choice) => choice.role === 'back'),
      allowExit: true,
    });
    if (answer.action !== 'select') {
      return createPromptActionResult(answer.action);
    }
    return createPromptResult(parseSelectionInput(
      answer.value!,
      choices,
      defaults,
      true,
    ));
  };

  const confirm: NonNullable<CliPrompt['confirm']> = async ({ message, defaultValue = true }) => {
    const suffix = defaultValue ? 'Y/n' : 'y/N';
    const answer = await ask(`${message} [${suffix}] `, { mode: 'confirm' });
    if (answer.action !== 'select') {
      return createPromptActionResult(answer.action);
    }
    const normalized = answer.value!.trim().toLowerCase();
    if (!normalized) {
      return createPromptResult(defaultValue);
    }
    return createPromptResult(normalized === 'y' || normalized === 'yes');
  };

  const inputPrompt: NonNullable<CliPrompt['input']> = async ({ message, defaultValue }) => {
    const answer = await ask(defaultValue === undefined
      ? `${message}: `
      : `${message}（默认：${defaultValue}）: `, { mode: 'text' });
    if (answer.action !== 'select') {
      return answer;
    }
    return createPromptResult(answer.value!.trim() === '' && defaultValue !== undefined ? defaultValue : answer.value!);
  };

  const passwordPrompt: NonNullable<CliPrompt['password']> = async ({ message }) => {
    const answer = await ask(`${message}: `, { hidden: true, mode: 'text' });
    if (answer.action !== 'select') {
      return answer;
    }
    return createPromptResult(answer.value!);
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
          label: value === 'both' ? '全部支持平台' : value === 'codex' ? 'Codex' : 'Claude Code',
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
        const selectedKeysAnswer = await ask(
          `选择要更新的 ${configOptions.pluginName} 配置项\n${body}\n选择编号，可用逗号分隔多个，直接回车跳过：`,
          { mode: 'menu', allowExit: true },
        );
        if (selectedKeysAnswer.action !== 'select') {
          return {
            selectedScope,
            updates: {},
            updatedKeys: [],
            removeKeys: [],
            cancelled: true,
          };
        }
        const selectedKeys = parseSelectionInput(
          selectedKeysAnswer.value!,
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
          mode: 'text',
        });
        if (answer.action !== 'select') {
          return {
            selectedScope,
            updates,
            updatedKeys: Object.keys(updates),
            removeKeys,
            cancelled: true,
          };
        }
        const parsed = parsePromptedConfigValue(key, definition, answer.value!);
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
  const baseRunner = input.nativeCliRunner ?? getDefaultNativeCliRunner();
  const contextShell: Pick<CommandExecutionContext, 'reporter' | 'debugLogger'> = {
    reporter,
    debugLogger,
  };

  return {
    env,
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
  const hasInjectedTuiRunner = Boolean(input.tuiRunner);
  const requestedInteractive = input.interactive ?? (hasInjectedPrompt || hasInjectedTuiRunner ? true : isTty);
  const interactive = requestedInteractive
    && !isCi
    && (isTty || hasInjectedPrompt || hasInjectedTuiRunner);
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
  const reporter = createSessionAwareReporter(
    input.reporter ?? createIoReporter(io, diagnostics),
  );
  const debugLogger = input.debugLogger ?? createFileDebugLogger(diagnostics);
  const prompt = input.prompt ?? (interactive
    ? createInkPrompt({
        input: stdin,
        outputSink: promptOutputSink,
      })
    : createUnavailablePrompt());
  const tuiRunner = input.tuiRunner ?? createInkTuiRunner();
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
    stdin,
    isTty,
    isCi,
    tuiRunner,
    tuiOutput: promptOutputSink,
  };
}
