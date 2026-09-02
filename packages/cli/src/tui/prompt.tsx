import type {
  CliConfigPromptOptions,
  CliConfigPromptResult,
  CliConfigPromptScope,
  CliConfigPromptSchemaEntry,
  CliConfigPromptValue,
  CliPrompt,
  CliPromptChoice,
  CliPromptOutputSink,
  CliPromptResult,
} from '../commands/runtime.js';
import { createInkTuiRunner, type TuiRunner } from './runner.js';
import {
  ConfirmView,
  MultiSelectView,
  PasswordInputView,
  PromptFrame,
  SelectView,
  TextInputView,
} from './views.js';

export interface InkPromptOptions {
  input?: NodeJS.ReadableStream;
  outputSink?: CliPromptOutputSink;
  runner?: TuiRunner;
}

function unwrap<T>(result: CliPromptResult<T>): T {
  if (result.action !== 'select' || result.value === undefined) {
    throw new Error('Interactive prompt cancelled.');
  }
  return result.value;
}

function enabledChoices(choices: CliPromptChoice[]): CliPromptChoice[] {
  const enabled = choices.filter((choice) => !choice.disabled);
  if (enabled.length === 0) {
    throw new Error('没有可选择的候选项。');
  }
  return enabled;
}

function pluginChoices(options: Parameters<NonNullable<CliPrompt['selectPlugins']>>[0]): CliPromptChoice[] {
  return options.candidates.map((candidate) => ({
    value: candidate.id,
    label: `${candidate.pluginName}${candidate.platform ? ` / ${candidate.platform}` : ''}${candidate.scope ? ` / ${candidate.scope}` : ''}`,
    disabled: candidate.selectable ? undefined : candidate.disabledReason ?? true,
  }));
}

function shouldPromptConfigKey(
  key: string,
  definition: CliConfigPromptSchemaEntry,
  options: CliConfigPromptOptions,
): boolean {
  const currentValue = options.currentValues?.[key];
  const configured = currentValue !== undefined || options.configuredKeys?.includes(key) === true;
  return Boolean(definition.required || options.requiredKeys?.includes(key) || !configured);
}

function configChoiceLabel(
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
  return definition.sensitive
    ? `${label}（当前：已配置）`
    : `${label}（当前：${String(currentValue)}）`;
}

function parseConfigValue(
  key: string,
  definition: CliConfigPromptSchemaEntry,
  answer: string,
): CliConfigPromptValue | undefined {
  if (answer.trim() === '') {
    return undefined;
  }
  if (definition.type === 'number') {
    const value = Number(answer.trim());
    if (!Number.isFinite(value)) {
      throw new Error(`配置项 ${key} 需要数字。`);
    }
    return value;
  }
  return answer;
}

export function createInkPrompt(options: InkPromptOptions = {}): CliPrompt {
  const input = options.input ?? process.stdin;
  const output = options.outputSink ?? process.stderr;
  const runner = options.runner ?? createInkTuiRunner();

  const select: NonNullable<CliPrompt['select']> = async ({
    message,
    choices,
    defaultValue,
    pageSize,
  }) => {
    enabledChoices(choices);
    return runner.launch({
      input,
      output,
      render: (complete) => (
        <SelectView
          message={message}
          choices={choices}
          defaultValue={defaultValue}
          pageSize={pageSize}
          onComplete={complete}
        />
      ),
    });
  };

  async function runMultiSelect(
    promptOptions: Parameters<NonNullable<CliPrompt['multiSelect']>>[0],
    keepEmptyDefaults: boolean,
  ): Promise<CliPromptResult<string[]>> {
    const enabled = enabledChoices(promptOptions.choices);
    const defaults = keepEmptyDefaults
      ? promptOptions.defaultValues ?? []
      : promptOptions.defaultValues && promptOptions.defaultValues.length > 0
        ? promptOptions.defaultValues
        : [enabled[0]!.value];
    return runner.launch({
      input,
      output,
      render: (complete) => (
        <MultiSelectView
          message={promptOptions.message}
          choices={promptOptions.choices}
          defaultValues={defaults}
          pageSize={promptOptions.pageSize}
          onComplete={complete}
        />
      ),
    });
  }

  const multiSelect: NonNullable<CliPrompt['multiSelect']> = async (promptOptions) =>
    runMultiSelect(promptOptions, false);

  const confirm: NonNullable<CliPrompt['confirm']> = async ({ message, defaultValue }) =>
    runner.launch({
      input,
      output,
      render: (complete) => (
        <PromptFrame title="确认" help="y 确认 · n 拒绝 · Esc 取消 · Ctrl-C 退出">
          <ConfirmView message={message} defaultValue={defaultValue} onComplete={complete} />
        </PromptFrame>
      ),
    });

  const inputPrompt: NonNullable<CliPrompt['input']> = async ({ message, defaultValue }) =>
    runner.launch({
      input,
      output,
      render: (complete) => (
        <TextInputView message={message} defaultValue={defaultValue} onComplete={complete} />
      ),
    });

  const passwordPrompt: NonNullable<CliPrompt['password']> = async ({ message }) =>
    runner.launch({
      input,
      output,
      render: (complete) => (
        <PasswordInputView message={message} onComplete={complete} />
      ),
    });

  const prompt: CliPrompt = {
    select,
    multiSelect,
    confirm,
    input: inputPrompt,
    password: passwordPrompt,
    selectPlatform: async ({ available, defaultValue, message }) =>
      unwrap(await select({
        message: message ?? '选择目标平台',
        choices: available.map((value) => ({
          value,
          label: value === 'both' ? '全部支持平台' : value === 'codex' ? 'Codex' : 'Claude Code',
        })),
        defaultValue,
      })),
    selectScope: async ({ defaultValue = 'user' }) =>
      unwrap(await select({
        message: '选择安装范围',
        choices: [
          { value: 'user', label: 'user' },
          { value: 'project', label: 'project' },
        ],
        defaultValue,
      })),
    selectPlugins: async (pluginOptions) => {
      const choices = pluginChoices(pluginOptions);
      return pluginOptions.allowMultiple
        ? unwrap(await multiSelect({
            message: `选择要${pluginOptions.command === 'install' ? '安装' : '卸载'}的插件`,
            choices,
            defaultValues: pluginOptions.defaultValues,
          }))
        : [unwrap(await select({
            message: `选择要${pluginOptions.command === 'install' ? '安装' : '卸载'}的插件`,
            choices,
            defaultValue: pluginOptions.defaultValues?.[0],
          }))];
    },
  };

  prompt.configurePlugin = async (configOptions): Promise<CliConfigPromptResult> => {
    const selectedScope = configOptions.allowedScopes.length > 1
      ? unwrap(await select({
          message: `选择 ${configOptions.pluginName} 配置写入范围`,
          choices: configOptions.allowedScopes.map((value) => ({ value, label: value })),
          defaultValue: configOptions.initialScope,
        })) as CliConfigPromptScope
      : configOptions.initialScope;
    const updates: Record<string, CliConfigPromptValue> = {};
    const removeKeys: string[] = [];
    const keysToPrompt = new Set<string>();
    const optionalChoices: CliPromptChoice[] = [];

    for (const [key, definition] of Object.entries(configOptions.schema)) {
      if (shouldPromptConfigKey(key, definition, configOptions)) {
        keysToPrompt.add(key);
      } else {
        optionalChoices.push({
          value: key,
          label: configChoiceLabel(key, definition, configOptions),
        });
      }
    }

    if (optionalChoices.length > 0) {
      const optionalResult = await runMultiSelect({
        message: `选择要更新的 ${configOptions.pluginName} 配置项`,
        choices: optionalChoices,
        defaultValues: [],
      }, true);
      if (optionalResult.action !== 'select') {
        return {
          selectedScope,
          updates: {},
          updatedKeys: [],
          removeKeys: [],
          cancelled: true,
        };
      }
      for (const key of optionalResult.value ?? []) {
        keysToPrompt.add(key);
      }
    }

    for (const [key, definition] of Object.entries(configOptions.schema)) {
      if (!keysToPrompt.has(key)) {
        continue;
      }
      const label = definition.label ?? key;
      if (definition.enum && definition.enum.length > 0) {
        updates[key] = unwrap(await select({
          message: label,
          choices: definition.enum.map((value) => ({ value: String(value), label: String(value) })),
          defaultValue: configOptions.currentValues?.[key] === undefined
            ? undefined
            : String(configOptions.currentValues[key]),
        }));
        continue;
      }
      if (definition.type === 'boolean') {
        const current = configOptions.currentValues?.[key];
        updates[key] = unwrap(await confirm({
          message: label,
          defaultValue: current === undefined ? Boolean(definition.default) : Boolean(current),
        }));
        continue;
      }

      const current = configOptions.currentValues?.[key];
      const configured = current !== undefined || configOptions.configuredKeys?.includes(key) === true;
      const answerResult = definition.sensitive
        ? await passwordPrompt({ message: configured ? `${label}（当前：已配置）` : label })
        : await inputPrompt({
            message: configured ? `${label}（当前：${String(current)}）` : label,
          });
      if (answerResult.action !== 'select') {
        return {
          selectedScope,
          updates,
          updatedKeys: Object.keys(updates),
          removeKeys,
          cancelled: true,
        };
      }
      const parsed = parseConfigValue(key, definition, answerResult.value ?? '');
      if (parsed !== undefined) {
        updates[key] = parsed;
      } else if (!definition.required && configured) {
        removeKeys.push(key);
      }
    }

    return {
      selectedScope,
      updates,
      updatedKeys: Object.keys(updates),
      removeKeys,
      cancelled: false,
    };
  };

  return prompt;
}
