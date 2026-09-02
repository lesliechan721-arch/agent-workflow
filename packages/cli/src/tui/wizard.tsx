import { Text, useInput, useWindowSize } from 'ink';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type {
  CommandWizardPluginCandidate,
  CommandWizardRequest,
  CommandWizardResult,
  CommandWizardSelection,
} from '../commands/wizard.js';
import { WIZARD_FAILURE_MESSAGE } from '../commands/wizard.js';
import type { CliPromptChoice, CliPromptResult } from '../commands/runtime.js';
import {
  type RebuildProgressFeed,
  type RebuildProgressSnapshot,
} from '../output/rebuild-progress.js';
import { renderEquivalentCommandDisplays } from '../output/equivalent-command.js';
import { resolveTuiSizePolicy } from './layout.js';
import {
  ConfirmView,
  MultiSelectView,
  PasswordInputView,
  PromptFrame,
  SelectView,
  TextInputView,
} from './views.js';
import { tuiTheme } from './theme.js';

type Page = 'platform' | 'scope' | 'plugins' | 'key' | 'value' | 'confirm' | 'busy' | 'result';

function commandLabel(command: CommandWizardRequest<unknown>['command']): string {
  const labels: Record<CommandWizardRequest<unknown>['command'], string> = {
    install: '安装',
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

function isPrivateField(field: ReturnType<typeof valueField>): boolean {
  return field?.sensitive === true;
}

function equivalentCommandDisplays<T>(
  request: CommandWizardRequest<T>,
  selection: CommandWizardSelection,
): Array<{ label: string; text: string }> {
  return (request.equivalentCommandTokens
      ? renderEquivalentCommandDisplays(request.equivalentCommandTokens(selection))
      : undefined)
    ?? [{ label: 'POSIX shell 命令', text: request.equivalentCommand(selection) }];
}

function parseValue(raw: string, valueJson = false): unknown {
  if (valueJson) return raw;
  return raw;
}

function messageWindow(messages: string[], offset: number): {
  messages: string[];
  hiddenAbove: number;
  hiddenBelow: number;
} {
  const start = Math.min(Math.max(offset, 0), Math.max(0, messages.length - 8));
  const visible = messages.slice(start, start + 8);
  return {
    messages: visible,
    hiddenAbove: start,
    hiddenBelow: Math.max(0, messages.length - start - visible.length),
  };
}

function MessageWindow(props: { messages: string[]; offset: number }): React.JSX.Element {
  const window = messageWindow(props.messages, props.offset);
  return <>
    {window.hiddenAbove > 0
      ? <Text color={tuiTheme.colors.muted}>↑ 还有 {window.hiddenAbove} 项</Text>
      : null}
    {window.messages.map((message, index) => (
      <Text key={`${index}:${message}`} wrap="truncate-end">{message}</Text>
    ))}
    {window.hiddenBelow > 0
      ? <Text color={tuiTheme.colors.muted}>↓ 还有 {window.hiddenBelow} 项</Text>
      : null}
  </>;
}

function BusyView(props: {
  command: string;
  target: string;
  phase?: string;
  messages: string[];
  messageOffset: number;
  startedAt: number;
  size?: { columns: number; rows: number };
}): React.JSX.Element {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - props.startedAt) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [props.startedAt]);
  const frame = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'][elapsed % 10];
  return (
    <PromptFrame
      title={`${frame} 正在执行 ${props.command}`}
      help="PgUp/PgDn 消息 · Ctrl-C 完成后退出"
      size={props.size}
    >
      <Text wrap="truncate-end">目标：{props.target}</Text>
      {props.phase ? <Text wrap="truncate-end">阶段：{props.phase}</Text> : null}
      <Text color={tuiTheme.colors.muted}>已用时：{elapsed}s</Text>
      <MessageWindow messages={props.messages} offset={props.messageOffset} />
    </PromptFrame>
  );
}

function receiptLines(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  const receipt = value as {
    overallState?: unknown;
    targetResults?: unknown[];
  };
  if (typeof receipt.overallState !== 'string' || !Array.isArray(receipt.targetResults)) return [];
  const overallState = receipt.overallState === 'succeeded' || receipt.overallState === 'failed'
    ? receipt.overallState
    : 'unknown';
  return [`收据：${overallState}`];
}

interface WizardExecutionState<T> {
  selection: CommandWizardSelection;
  value?: T;
  failed: boolean;
  unexpectedFailure: boolean;
}

export function CommandWizard<T>(props: {
  request: CommandWizardRequest<T>;
  progress?: RebuildProgressFeed;
  onComplete: (result: CommandWizardResult<T>) => void;
  size?: { columns: number; rows: number };
}): React.JSX.Element {
  const windowSize = useWindowSize();
  const size = props.size ?? windowSize;
  const inputActive = resolveTuiSizePolicy(size.columns, size.rows).mode !== 'too-small';
  const selectionRows = Math.max(1, size.rows - 3);
  const [selection, setSelection] = useState<CommandWizardSelection>(() => ({
    ...props.request.initial,
    plugins: [...props.request.initial.plugins],
  }));
  const [page, setPage] = useState<Page>(() => nextPage(props.request));
  const [startedAt, setStartedAt] = useState(0);
  const [executionResult, setExecutionResult] = useState<WizardExecutionState<T>>();
  const [progress, setProgress] = useState<RebuildProgressSnapshot>(
    () => props.progress?.get() ?? { messages: [] },
  );
  const [messageOffset, setMessageOffset] = useState(0);
  const exitAfterBusy = useRef(false);
  const choices = useMemo(
    () => pluginChoices(props.request, selection),
    [props.request, selection],
  );
  const cancel = useCallback(() => props.onComplete({ cancelled: true }), [props.onComplete]);

  useEffect(() => props.progress?.subscribe((snapshot) => {
    setProgress(snapshot);
    setMessageOffset(Math.max(0, snapshot.messages.length - 8));
  }), [props.progress]);

  useInput((input, key) => {
    if (!inputActive) {
      const closeRequested = key.escape
        || input.toLowerCase() === 'q'
        || (key.ctrl && input === 'c');
      if (page === 'result' && closeRequested) {
        props.onComplete(executionResult!.failed
          ? { cancelled: false, selection: executionResult!.selection, failed: true }
          : {
              cancelled: false,
              selection: executionResult!.selection,
              value: executionResult!.value,
            });
      } else if (page === 'busy' && closeRequested) {
        exitAfterBusy.current = true;
      } else if (key.ctrl && input === 'c') {
        cancel();
      }
      return;
    }
    if ((page === 'busy' || page === 'result') && (key.pageUp || key.pageDown)) {
      setMessageOffset((current) => Math.min(
        Math.max(current + (key.pageUp ? -8 : 8), 0),
        Math.max(0, progress.messages.length - 8),
      ));
      return;
    }
    const closeRequested = key.return
      || key.escape
      || input.toLowerCase() === 'q'
      || (key.ctrl && input === 'c');
    if (page === 'result' && closeRequested) {
      props.onComplete(executionResult!.failed
        ? { cancelled: false, selection: executionResult!.selection, failed: true }
        : {
            cancelled: false,
            selection: executionResult!.selection,
            value: executionResult!.value,
          });
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
    props.progress?.clearCurrent();
    setStartedAt(Date.now());
    setPage('busy');
    try {
      const value = await props.request.execute(finalSelection);
      const failed = props.request.resultState?.(value) === 'failed';
      const result: WizardExecutionState<T> = {
        selection: finalSelection,
        value,
        failed,
        unexpectedFailure: false,
      };
      if (exitAfterBusy.current) props.onComplete(failed
        ? { cancelled: false, selection: finalSelection, failed: true }
        : { cancelled: false, selection: finalSelection, value });
      else {
        setExecutionResult(result);
        setPage('result');
      }
    } catch {
      const result: WizardExecutionState<T> = {
        selection: finalSelection,
        failed: true,
        unexpectedFailure: true,
      };
      if (exitAfterBusy.current) {
        props.onComplete({ cancelled: false, selection: finalSelection, failed: true });
      }
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
      size={size}
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
      size={size}
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
          pageSize={selectionRows}
          size={size}
          onComplete={(result) => {
            if (result.action === 'select' && (result.value?.length ?? 0) === 0) return;
            handlePrompt('plugins', result, (plugins) => ({ plugins }));
          }}
        />
      : <SelectView
          key="plugins"
          message={`选择要${commandLabel(props.request.command)}的插件`}
          choices={choices}
          pageSize={selectionRows}
          size={size}
          onComplete={(result) => handlePrompt('plugins', result, (plugin) => ({ plugins: [plugin] }))}
        />;
  }
  if (page === 'key') {
    return <SelectView
      key="key"
      message="选择配置项"
      choices={keyChoices(props.request, selection)}
      pageSize={selectionRows}
      size={size}
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
        size={size}
        onComplete={(result) => handlePrompt('value', result, (value) => ({
          value: valueJson ? value : value === 'true',
        }))}
      />;
    }
    if (
      field
      && field.type !== 'object'
      && field.choices?.allowCustom === false
    ) {
      const presets = field.choices.presets;
      return <SelectView
        key="value"
        message={message}
        choices={presets.map((preset) => ({
          value: valueJson ? JSON.stringify(preset.value) : String(preset.value),
          label: preset.title,
        }))}
        defaultValue={field.default !== undefined
          ? valueJson ? JSON.stringify(field.default) : String(field.default)
          : valueJson ? JSON.stringify(presets[0]?.value) : String(presets[0]?.value ?? '')}
        pageSize={selectionRows}
        size={size}
        onComplete={(result) => handlePrompt('value', result, (value) => ({ value }))}
      />;
    }
    if (isPrivateField(field)) {
      return <PasswordInputView
        message={message}
        size={size}
        onComplete={(result) => handlePrompt('value', result, (value) => ({
          value: parseValue(value, valueJson),
        }))}
      />;
    }
    return <TextInputView
      message={message}
      size={size}
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
      target={progress.current?.target ?? selection.plugins.join(', ')}
      phase={progress.current?.phase}
      messages={progress.messages}
      messageOffset={messageOffset}
      startedAt={startedAt}
      size={size}
    />;
  }
  if (page === 'result') {
    const failed = executionResult?.failed === true;
    const receipt = receiptLines(executionResult?.value);
    return <PromptFrame
      title="执行结果"
      help="PgUp/PgDn 消息 · Enter/q 退出"
      size={size}
    >
      <Text color={failed ? tuiTheme.statusColors.error : tuiTheme.statusColors.success}>
        {executionResult?.unexpectedFailure
          ? WIZARD_FAILURE_MESSAGE
          : failed ? '操作失败。' : '操作已完成。'}
      </Text>
      <MessageWindow messages={progress.messages} offset={messageOffset} />
      {receipt.map((line, index) => (
        <Text key={`receipt:${index}:${line}`} wrap="truncate-end">{line}</Text>
      ))}
    </PromptFrame>;
  }
  const isTemplate = props.request.commandIsTemplate?.(selection) === true;
  return (
    <PromptFrame
      title="确认参数"
      help="y 执行 · n 取消 · Esc 取消 · Ctrl-C 退出"
      size={size}
    >
      <Text wrap="truncate-end">操作：{commandLabel(props.request.command)}</Text>
      <Text wrap="truncate-end">插件：{selection.plugins.join(', ')}</Text>
      {selection.platform ? <Text wrap="truncate-end">平台：{selection.platform}</Text> : null}
      {selection.scope ? <Text wrap="truncate-end">范围：{selection.scope}</Text> : null}
      {selection.key ? <Text wrap="truncate-end">配置项：{selection.key}</Text> : null}
      {equivalentCommandDisplays(props.request, selection).map((display) => (
        <Text key={display.label} wrap="truncate-end">
          {isTemplate ? `${display.label}模板` : display.label}：{display.text}
        </Text>
      ))}
      {isTemplate
        ? <Text color={tuiTheme.colors.muted} wrap="truncate-end">命令模板；替换占位符后执行。</Text>
        : null}
      {props.request.destructive
        ? <Text color={tuiTheme.statusColors.warning}>此操作会删除已有内容。</Text>
        : null}
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
    </PromptFrame>
  );
}
