import { ConfirmInput, PasswordInput, TextInput } from '@inkjs/ui';
import { Box, Text, useInput, useWindowSize } from 'ink';
import { useState, type ReactNode } from 'react';

import type {
  CliPromptAction,
  CliPromptChoice,
  CliPromptResult,
} from '../commands/runtime.js';
import { resolveTuiKeyAction, type TuiInputMode } from './keys.js';
import { resolveTuiSizePolicy } from './layout.js';
import { tuiTheme } from './theme.js';

type Complete<T> = (result: CliPromptResult<T>) => void;

function selected<T>(value: T): CliPromptResult<T> {
  return { action: 'select', cancelled: false, value };
}

function action<T>(value: Exclude<CliPromptAction, 'select'>): CliPromptResult<T> {
  return { action: value, cancelled: value === 'cancel' };
}

function useGlobalPromptKeys<T>(options: {
  mode: TuiInputMode;
  allowBack?: boolean;
  onComplete: Complete<T>;
}): void {
  useInput((input, key) => {
    const resolved = resolveTuiKeyAction(
      { input, key },
      { mode: options.mode, allowBack: options.allowBack },
    );
    if (resolved) {
      options.onComplete(action(resolved));
    }
  });
}

export function PromptFrame(props: {
  title: string;
  help: string;
  children: ReactNode;
  size?: { columns: number; rows: number };
}): React.JSX.Element {
  const windowSize = useWindowSize();
  const { columns, rows } = props.size ?? windowSize;
  const policy = resolveTuiSizePolicy(columns, rows);

  if (policy.mode === 'three-column') {
    return (
      <Box width="100%" height={policy.rows} overflow="hidden" gap={2} paddingX={1}>
        <Box width="24%" borderStyle="round" borderColor={tuiTheme.colors.border} paddingX={1}>
          <Text bold color={tuiTheme.colors.accent}>{props.title}</Text>
        </Box>
        <Box width="52%" flexDirection="column" paddingX={1}>{props.children}</Box>
        <Box width="24%" borderStyle="round" borderColor={tuiTheme.colors.border} paddingX={1}>
          <Text color={tuiTheme.colors.muted}>{props.help}</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" height={policy.rows} overflow="hidden" paddingX={1}>
      {policy.message ? <Text color={tuiTheme.statusColors.warning}>{policy.message}</Text> : null}
      <Text bold color={tuiTheme.colors.accent}>{props.title}</Text>
      <Box flexDirection="column">{props.children}</Box>
      <Text color={tuiTheme.colors.muted}>{props.help}</Text>
    </Box>
  );
}

function initialChoiceIndex(choices: CliPromptChoice[], defaultValue?: string): number {
  const defaultIndex = choices.findIndex((choice) =>
    !choice.disabled && choice.value === defaultValue);
  if (defaultIndex >= 0) {
    return defaultIndex;
  }
  return Math.max(0, choices.findIndex((choice) => !choice.disabled));
}

function moveChoiceIndex(
  choices: CliPromptChoice[],
  current: number,
  direction: -1 | 1,
): number {
  for (let offset = 1; offset <= choices.length; offset += 1) {
    const candidate = (current + direction * offset + choices.length) % choices.length;
    if (!choices[candidate]?.disabled) {
      return candidate;
    }
  }
  return current;
}

function visibleChoiceEntries(
  choices: CliPromptChoice[],
  focusedIndex: number,
  pageSize?: number,
): Array<{ choice: CliPromptChoice; index: number }> {
  const normalizedPageSize = pageSize && pageSize > 0
    ? Math.min(pageSize, choices.length)
    : choices.length;
  const start = Math.max(0, Math.min(
    focusedIndex - Math.floor(normalizedPageSize / 2),
    choices.length - normalizedPageSize,
  ));
  return choices
    .slice(start, start + normalizedPageSize)
    .map((choice, offset) => ({ choice, index: start + offset }));
}

export function SelectView(props: {
  message: string;
  choices: CliPromptChoice[];
  defaultValue?: string;
  pageSize?: number;
  size?: { columns: number; rows: number };
  onComplete: Complete<string>;
}): React.JSX.Element {
  const [focusedIndex, setFocusedIndex] = useState(() =>
    initialChoiceIndex(props.choices, props.defaultValue));
  const allowBack = props.choices.some((choice) => choice.role === 'back');
  useGlobalPromptKeys({ mode: 'menu', allowBack, onComplete: props.onComplete });
  useInput((_input, key) => {
    if (key.upArrow) {
      setFocusedIndex((value) => moveChoiceIndex(props.choices, value, -1));
    } else if (key.downArrow) {
      setFocusedIndex((value) => moveChoiceIndex(props.choices, value, 1));
    } else if (key.return) {
      const choice = props.choices[focusedIndex];
      if (!choice || choice.disabled) {
        return;
      }
      if (choice.role === 'back') {
        props.onComplete(action('back'));
      } else if (choice.role === 'exit') {
        props.onComplete(action('exit'));
      } else {
        props.onComplete(selected(choice.value));
      }
    }
  });
  const visibleChoices = visibleChoiceEntries(props.choices, focusedIndex, props.pageSize);

  return (
    <PromptFrame
      title={props.message}
      help="↑/↓ 移动 · Enter 选择 · Esc 返回 · q 退出"
      size={props.size}
    >
      {visibleChoices.map(({ choice, index }) => (
        <Text
          key={choice.value}
          color={choice.disabled ? tuiTheme.colors.muted : undefined}
          bold={index === focusedIndex && !choice.disabled}
        >
          {index === focusedIndex && !choice.disabled ? '› ' : '  '}
          {choice.label}
          {choice.disabled
            ? `（${typeof choice.disabled === 'string' ? choice.disabled : '不可选'}）`
            : ''}
        </Text>
      ))}
    </PromptFrame>
  );
}

export function MultiSelectView(props: {
  message: string;
  choices: CliPromptChoice[];
  defaultValues?: string[];
  pageSize?: number;
  size?: { columns: number; rows: number };
  onComplete: Complete<string[]>;
}): React.JSX.Element {
  const [focusedIndex, setFocusedIndex] = useState(() =>
    initialChoiceIndex(props.choices, props.defaultValues?.[0]));
  const [values, setValues] = useState(() => new Set(
    (props.defaultValues ?? []).filter((value) =>
      props.choices.some((choice) => choice.value === value && !choice.disabled)),
  ));
  const allowBack = props.choices.some((choice) => choice.role === 'back');
  useGlobalPromptKeys({ mode: 'menu', allowBack, onComplete: props.onComplete });
  useInput((input, key) => {
    if (key.upArrow) {
      setFocusedIndex((value) => moveChoiceIndex(props.choices, value, -1));
    } else if (key.downArrow) {
      setFocusedIndex((value) => moveChoiceIndex(props.choices, value, 1));
    } else if (input === ' ') {
      const choice = props.choices[focusedIndex];
      if (!choice || choice.disabled || choice.role) {
        return;
      }
      setValues((current) => {
        const next = new Set(current);
        if (next.has(choice.value)) {
          next.delete(choice.value);
        } else {
          next.add(choice.value);
        }
        return next;
      });
    } else if (key.return) {
      props.onComplete(selected([...values]));
    }
  });
  const visibleChoices = visibleChoiceEntries(props.choices, focusedIndex, props.pageSize);

  return (
    <PromptFrame
      title={props.message}
      help="↑/↓ 移动 · Space 切换 · Enter 完成 · Esc 返回 · q 退出"
      size={props.size}
    >
      {visibleChoices.map(({ choice, index }) => (
        <Text
          key={choice.value}
          color={choice.disabled ? tuiTheme.colors.muted : undefined}
          bold={index === focusedIndex && !choice.disabled}
        >
          {values.has(choice.value) ? '◆' : '◇'} {choice.label}
          {choice.disabled
            ? `（${typeof choice.disabled === 'string' ? choice.disabled : '不可选'}）`
            : ''}
        </Text>
      ))}
    </PromptFrame>
  );
}

export function ConfirmView(props: {
  message: string;
  defaultValue?: boolean;
  onComplete: Complete<boolean>;
}): React.JSX.Element {
  useGlobalPromptKeys({ mode: 'confirm', onComplete: props.onComplete });
  return (
    <Box flexDirection="column">
      <Text>{props.message}</Text>
      <ConfirmInput
        defaultChoice={props.defaultValue === false ? 'cancel' : 'confirm'}
        onConfirm={() => props.onComplete(selected(true))}
        onCancel={() => props.onComplete(selected(false))}
      />
    </Box>
  );
}

export function TextInputView(props: {
  message: string;
  defaultValue?: string;
  size?: { columns: number; rows: number };
  onComplete: Complete<string>;
}): React.JSX.Element {
  useGlobalPromptKeys({ mode: 'text', onComplete: props.onComplete });
  return (
    <PromptFrame title={props.message} help="Enter 完成 · Esc 取消 · Ctrl-C 退出" size={props.size}>
      <TextInput
        defaultValue={props.defaultValue}
        onSubmit={(value) => props.onComplete(selected(
          value === '' && props.defaultValue !== undefined ? props.defaultValue : value,
        ))}
      />
    </PromptFrame>
  );
}

export function PasswordInputView(props: {
  message: string;
  size?: { columns: number; rows: number };
  onComplete: Complete<string>;
}): React.JSX.Element {
  useGlobalPromptKeys({ mode: 'text', onComplete: props.onComplete });
  return (
    <PromptFrame
      title={props.message}
      help="输入已隐藏 · Enter 完成 · Esc 取消 · Ctrl-C 退出"
      size={props.size}
    >
      <PasswordInput onSubmit={(value) => props.onComplete(selected(value))} />
    </PromptFrame>
  );
}
