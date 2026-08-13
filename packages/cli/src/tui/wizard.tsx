import { Box, Text, useInput } from 'ink';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type {
  CommandWizardPluginCandidate,
  CommandWizardRequest,
  CommandWizardResult,
  CommandWizardSelection,
} from '../commands/wizard.js';
import type { CliPromptChoice, CliPromptResult } from '../commands/runtime.js';
import {
  ConfirmView,
  MultiSelectView,
  PasswordInputView,
  SelectView,
  TextInputView,
} from './views.js';
import { PromptFrame } from './views.js';
import { tuiTheme } from './theme.js';

type Page = 'platform' | 'scope' | 'plugins' | 'key' | 'value' | 'confirm' | 'busy' | 'result';

function commandLabel(command: CommandWizardRequest<unknown>['command']): string {
  const labels: Record<CommandWizardRequest<unknown>['command'], string> = {
    install: '安装',
    upgrade: '升级',
    reinstall: '重装',
    uninstall: '卸载',
    cleanup: '清理',
    'config:list': '列出配置',
    'config:get': '读取配置',
    'config:set': '写入配置',
    'config:unset': '删除配置项',
    'config:reset': '重置配置',
  };
  return labels[command];
}

function nextPage<T>(request: CommandWizardRequest<T>, current?: Page): Page {
  const order: Page[] = [
    ...(request.promptForPlatform ? ['platform' as const] : []),
    ...(request.promptForScope ? ['scope' as const] : []),
    ...(request.pluginMode !== 'none' ? ['plugins' as const] : []),
    ...(request.promptForKey ? ['key' as const] : []),
    ...(request.promptForValue ? ['value' as const] : []),
    'confirm',
  ];
  if (!current) return order[0]!;
  return order[order.indexOf(current) + 1] ?? 'confirm';
}

function selectedValue<T>(result: CliPromptResult<T>): T | undefined {
  return result.action === 'select' ? result.value : undefined;
}

function pluginChoices<T>(
  request: CommandWizardRequest<T>,
  selection: CommandWizardSelection,
): CliPromptChoice[] {
  return request.candidates
    .filter((candidate) => request.isPluginVisible?.(candidate, selection) !== false)
    .map((candidate) => {
      const eligibility = request.isPluginSelectable?.(candidate, selection) ?? { selectable: true };
      return {
        value: candidate.pluginName,
        label: candidate.pluginName,
        description: candidate.description,
        disabled: eligibility.selectable ? undefined : eligibility.reason ?? '当前目标不能执行此操作',
      };
    });
}

function selectedCandidate<T>(
  request: CommandWizardRequest<T>,
  selection: CommandWizardSelection,
): CommandWizardPluginCandidate | undefined {
  return request.candidates.find((entry) => entry.pluginName === selection.plugins[0]);
}

function keyChoices<T>(
  request: CommandWizardRequest<T>,
  selection: CommandWizardSelection,
): CliPromptChoice[] {
  const candidate = selectedCandidate(request, selection);
  const schema = candidate?.configSchema ?? {};
  if (!candidate?.configSchema) {
    return (candidate?.configKeys ?? []).map((key) => ({ value: key, label: key }));
  }
  return Object.entries(schema).map(([key, field]) => ({
    value: key,
    label: field.title ?? key,
    description: field.description,
  }));
}

function valueField<T>(request: CommandWizardRequest<T>, selection: CommandWizardSelection) {
  return selectedCandidate(request, selection)?.configSchema?.[selection.key ?? ''];
}

function parseValue(raw: string, valueJson = false): unknown {
  if (valueJson) return raw;
  return raw;
}

function BusyView(props: { command: string; target: string; startedAt: number }): React.JSX.Element {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - props.startedAt) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [props.startedAt]);
  const frame = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'][elapsed % 10];
  return (
    <PromptFrame title={`${frame} 正在执行 ${props.command}`} help="Ctrl-C 将在当前写入完成后退出">
      <Text>目标：{props.target}</Text>
      <Text color={tuiTheme.colors.muted}>已用时：{elapsed}s</Text>
    </PromptFrame>
  );
}

export function CommandWizard<T>(props: {
  request: CommandWizardRequest<T>;
  onComplete: (result: CommandWizardResult<T>) => void;
}): React.JSX.Element {
  const [selection, setSelection] = useState<CommandWizardSelection>(() => ({
    ...props.request.initial,
    plugins: [...props.request.initial.plugins],
  }));
  const [page, setPage] = useState<Page>(() => nextPage(props.request));
  const [startedAt, setStartedAt] = useState(0);
  const [executionResult, setExecutionResult] = useState<CommandWizardResult<T>>();
  const exitAfterBusy = useRef(false);
  const choices = useMemo(
    () => pluginChoices(props.request, selection),
    [props.request, selection],
  );
  const cancel = useCallback(() => props.onComplete({ cancelled: true }), [props.onComplete]);

  useInput((input, key) => {
    const closeRequested = key.return
      || key.escape
      || input.toLowerCase() === 'q'
      || (key.ctrl && input === 'c');
    if (page === 'result' && closeRequested) {
      props.onComplete(executionResult!);
      return;
    }
    if (page === 'busy' && closeRequested) {
      exitAfterBusy.current = true;
      return;
    }
    if (!key.ctrl || input !== 'c') return;
    cancel();
  });

  const advance = useCallback((current: Page, patch: Partial<CommandWizardSelection>) => {
    setSelection((value) => ({ ...value, ...patch }));
    setPage(nextPage(props.request, current));
  }, [props.request]);

  const handlePrompt = useCallback(<V,>(
    current: Page,
    result: CliPromptResult<V>,
    patch: (value: V) => Partial<CommandWizardSelection>,
  ) => {
    const value = selectedValue(result);
    if (value === undefined) {
      cancel();
      return;
    }
    advance(current, patch(value));
  }, [advance, cancel]);

  const execute = useCallback(async () => {
    const finalSelection = selection;
    setStartedAt(Date.now());
    setPage('busy');
    try {
      const value = await props.request.execute(finalSelection);
      const result = { cancelled: false, selection: finalSelection, value };
      if (exitAfterBusy.current) props.onComplete(result);
      else {
        setExecutionResult(result);
        setPage('result');
      }
    } catch (error) {
      const result = { cancelled: false, selection: finalSelection, error };
      if (exitAfterBusy.current) props.onComplete(result);
      else {
        setExecutionResult(result);
        setPage('result');
      }
    }
  }, [props.onComplete, props.request, selection]);

  if (page === 'platform') {
    return <SelectView
      key="platform"
      message="选择目标平台"
      choices={[
        { value: 'codex', label: 'Codex' },
        { value: 'claude', label: 'Claude Code' },
        { value: 'both', label: '全部支持平台' },
      ]}
      defaultValue="both"
      onComplete={(result) => handlePrompt('platform', result, (platform) => ({
        platform: platform as CommandWizardSelection['platform'],
      }))}
    />;
  }
  if (page === 'scope') {
    return <SelectView
      key="scope"
      message="选择目标范围"
      choices={[
        { value: 'user', label: 'user' },
        { value: 'project', label: 'project' },
      ]}
      defaultValue="user"
      onComplete={(result) => handlePrompt('scope', result, (scope) => ({
        scope: scope as CommandWizardSelection['scope'],
      }))}
    />;
  }
  if (page === 'plugins') {
    return props.request.pluginMode === 'multiple'
      ? <MultiSelectView
          key="plugins"
          message={`选择要${commandLabel(props.request.command)}的插件`}
          choices={choices}
          onComplete={(result) => {
            if (result.action === 'select' && (result.value?.length ?? 0) === 0) return;
            handlePrompt('plugins', result, (plugins) => ({ plugins }));
          }}
        />
      : <SelectView
          key="plugins"
          message={`选择要${commandLabel(props.request.command)}的插件`}
          choices={choices}
          onComplete={(result) => handlePrompt('plugins', result, (plugin) => ({ plugins: [plugin] }))}
        />;
  }
  if (page === 'key') {
    return <SelectView
      key="key"
      message="选择配置项"
      choices={keyChoices(props.request, selection)}
      onComplete={(result) => handlePrompt('key', result, (key) => ({ key }))}
    />;
  }
  if (page === 'value') {
    const field = valueField(props.request, selection);
    const message = field?.title ?? selection.key ?? '配置值';
    const valueJson = props.request.valueJson === true;
    if (field?.type === 'boolean') {
      return <SelectView
        key="value"
        message={message}
        choices={[{ value: 'true', label: 'true' }, { value: 'false', label: 'false' }]}
        defaultValue={field.default === false ? 'false' : 'true'}
        onComplete={(result) => handlePrompt('value', result, (value) => ({
          value: valueJson ? value : value === 'true',
        }))}
      />;
    }
    if (field?.type === 'enum') {
      return <SelectView
        key="value"
        message={message}
        choices={(field.values ?? []).map((value) => ({
          value: valueJson ? JSON.stringify(value) : value,
          label: value,
        }))}
        defaultValue={typeof field.default === 'string'
          ? valueJson ? JSON.stringify(field.default) : field.default
          : valueJson ? JSON.stringify(field.values?.[0]) : field.values?.[0]}
        onComplete={(result) => handlePrompt('value', result, (value) => ({ value }))}
      />;
    }
    if (field?.sensitive) {
      return <PasswordInputView
        message={message}
        onComplete={(result) => handlePrompt('value', result, (value) => ({
          value: parseValue(value, valueJson),
        }))}
      />;
    }
    return <TextInputView
      message={message}
      defaultValue={field?.default === undefined
        ? undefined
        : valueJson ? JSON.stringify(field.default) : String(field.default)}
      onComplete={(result) => handlePrompt('value', result, (value) => ({
        value: parseValue(value, valueJson),
      }))}
    />;
  }
  if (page === 'busy') {
    return <BusyView
      command={commandLabel(props.request.command)}
      target={selection.plugins.join(', ')}
      startedAt={startedAt}
    />;
  }
  if (page === 'result') {
    const isTemplate = props.request.commandIsTemplate?.(selection) === true;
    const failed = executionResult?.error !== undefined
      || (executionResult?.value !== undefined
        && props.request.resultState?.(executionResult.value) === 'failed');
    return <PromptFrame title="执行结果" help="Enter 退出并输出稳定收据 · q 退出">
      <Text color={failed ? tuiTheme.statusColors.error : tuiTheme.statusColors.success}>
        {executionResult?.error
          ? `操作失败：${executionResult.error instanceof Error ? executionResult.error.message : String(executionResult.error)}`
          : failed ? '操作失败。' : '操作已完成。'}
      </Text>
      <Text>{isTemplate ? '命令模板' : '等价命令'}：{props.request.equivalentCommand(selection)}</Text>
      {isTemplate
        ? <Text color={tuiTheme.colors.muted}>请先替换 '&lt;sensitive-value&gt;'，再执行命令。</Text>
        : null}
    </PromptFrame>;
  }
  const isTemplate = props.request.commandIsTemplate?.(selection) === true;
  return (
    <Box flexDirection="column">
      <PromptFrame title="确认参数" help="y 执行 · n 取消 · Esc 取消 · Ctrl-C 退出">
        <Text>操作：{commandLabel(props.request.command)}</Text>
        <Text>插件：{selection.plugins.join(', ')}</Text>
        {selection.platform ? <Text>平台：{selection.platform}</Text> : null}
        {selection.scope ? <Text>范围：{selection.scope}</Text> : null}
        {selection.key ? <Text>配置项：{selection.key}</Text> : null}
        <Text wrap="wrap">{isTemplate ? '命令模板' : '等价命令'}：{props.request.equivalentCommand(selection)}</Text>
        {isTemplate
          ? <Text color={tuiTheme.colors.muted}>请先替换 '&lt;sensitive-value&gt;'，再执行命令。</Text>
          : null}
        {props.request.destructive
          ? <Text color={tuiTheme.statusColors.warning}>此操作会删除已有内容。</Text>
          : null}
      </PromptFrame>
      <ConfirmView
        message="执行以上命令？"
        defaultValue={true}
        onComplete={(result) => {
          if (result.action !== 'select' || result.value !== true) {
            cancel();
            return;
          }
          void execute();
        }}
      />
    </Box>
  );
}
