import { ConfirmInput } from '@inkjs/ui';
import { Box, Text, useInput, useWindowSize } from 'ink';
import { useState, type ReactNode } from 'react';

import type {
  CliPromptAction,
  CliPromptChoice,
  CliPromptResult,
} from '../commands/runtime.js';
import { ScreenFrame } from './components.js';
import { resolveTuiKeyAction, type TuiInputMode } from './keys.js';
import { resolveTuiSizePolicy } from './layout.js';
import { tuiTheme } from './theme.js';
import { InputDisplay, removeLastGrapheme } from './input-display.js';

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
  return (
    <ScreenFrame title={props.title} help={props.help} size={props.size}>
      {props.children}
    </ScreenFrame>
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
  rowBudget = Number.POSITIVE_INFINITY,
): Array<{ choice: CliPromptChoice; index: number }> {
  const maxChoices = pageSize && pageSize > 0
    ? Math.min(pageSize, choices.length)
    : choices.length;
  if (choices.length === 0 || maxChoices === 0 || rowBudget <= 0) return [];
  const focused = Math.min(Math.max(focusedIndex, 0), choices.length - 1);
  const indexes = [focused];
  let rows = choiceRowCost(choices[focused]!);
  let before = focused - 1;
  let after = focused + 1;
  while (indexes.length < maxChoices) {
    const next = before >= 0 ? before : after < choices.length ? after : undefined;
    if (next === undefined) break;
    const cost = choiceRowCost(choices[next]!);
    if (rows + cost > rowBudget) {
      if (before >= 0) before = -1;
      else break;
      continue;
    }
    indexes.push(next);
    rows += cost;
    if (next === before) before -= 1;
    else after += 1;
  }
  return indexes
    .sort((left, right) => left - right)
    .map((index) => ({ choice: choices[index]!, index }));
}

function choiceRowCost(choice: CliPromptChoice): number {
  return choice.description ? 2 : 1;
}

function promptChoiceRowBudget(rows: number): number {
  return Math.max(1, rows - 6);
}

function ChoiceRow(props: {
  choice: CliPromptChoice;
  focused: boolean;
  marker?: string;
}): React.JSX.Element {
  const disabledReason = props.choice.disabled
    ? typeof props.choice.disabled === 'string' ? props.choice.disabled : '不可选'
    : undefined;
  return (
    <Box
      flexDirection="column"
      width="100%"
      paddingX={1}
      backgroundColor={props.focused ? tuiTheme.colors.selectionBackground : undefined}
    >
      <Text
        color={props.choice.disabled ? tuiTheme.colors.muted : undefined}
        bold={props.focused}
        wrap="truncate-end"
      >
        {props.focused ? '› ' : '  '}
        {props.marker ? `${props.marker} ` : ''}
        {props.choice.label}
        {disabledReason ? `（${disabledReason}）` : ''}
      </Text>
      {props.choice.description
        ? (
            <Text color={tuiTheme.colors.muted} wrap="truncate-end">
              {'    '}{props.choice.description}
            </Text>
          )
        : null}
    </Box>
  );
}

export function SelectView(props: {
  message: string;
  choices: CliPromptChoice[];
  defaultValue?: string;
  pageSize?: number;
  size?: { columns: number; rows: number };
  onComplete: Complete<string>;
}): React.JSX.Element {
  const windowSize = useWindowSize();
  const size = props.size ?? windowSize;
  const inputActive = resolveTuiSizePolicy(size.columns, size.rows).mode !== 'too-small';
  const [focusedIndex, setFocusedIndex] = useState(() =>
    initialChoiceIndex(props.choices, props.defaultValue));
  const allowBack = props.choices.some((choice) => choice.role === 'back');
  useGlobalPromptKeys({ mode: 'menu', allowBack, onComplete: props.onComplete });
  useInput((input, key) => {
    if (key.upArrow || input.toLowerCase() === 'k') {
      setFocusedIndex((value) => moveChoiceIndex(props.choices, value, -1));
    } else if (key.downArrow || input.toLowerCase() === 'j') {
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
  }, { isActive: inputActive });
  const visibleChoices = visibleChoiceEntries(
    props.choices,
    focusedIndex,
    props.pageSize,
    promptChoiceRowBudget(size.rows),
  );

  return (
    <PromptFrame
      title={props.message}
      help="↑/↓ 移动 · Enter 选择 · Esc 返回 · q 退出"
      size={props.size}
    >
      {visibleChoices.map(({ choice, index }) => (
        <ChoiceRow
          key={choice.value}
          choice={choice}
          focused={index === focusedIndex && !choice.disabled}
        />
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
  const windowSize = useWindowSize();
  const size = props.size ?? windowSize;
  const inputActive = resolveTuiSizePolicy(size.columns, size.rows).mode !== 'too-small';
  const [focusedIndex, setFocusedIndex] = useState(() =>
    initialChoiceIndex(props.choices, props.defaultValues?.[0]));
  const [values, setValues] = useState(() => new Set(
    (props.defaultValues ?? []).filter((value) =>
      props.choices.some((choice) => choice.value === value && !choice.disabled)),
  ));
  const allowBack = props.choices.some((choice) => choice.role === 'back');
  useGlobalPromptKeys({ mode: 'menu', allowBack, onComplete: props.onComplete });
  useInput((input, key) => {
    if (key.upArrow || input.toLowerCase() === 'k') {
      setFocusedIndex((value) => moveChoiceIndex(props.choices, value, -1));
    } else if (key.downArrow || input.toLowerCase() === 'j') {
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
  }, { isActive: inputActive });
  const visibleChoices = visibleChoiceEntries(
    props.choices,
    focusedIndex,
    props.pageSize,
    promptChoiceRowBudget(size.rows),
  );

  return (
    <PromptFrame
      title={props.message}
      help="↑/↓ 移动 · Space 切换 · Enter 完成 · Esc 返回 · q 退出"
      size={props.size}
    >
      {visibleChoices.map(({ choice, index }) => (
        <ChoiceRow
          key={choice.value}
          choice={choice}
          focused={index === focusedIndex && !choice.disabled}
          marker={values.has(choice.value) ? '◆' : '◇'}
        />
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
  const windowSize = useWindowSize();
  const size = props.size ?? windowSize;
  const [value, setValue] = useState(props.defaultValue ?? '');
  useGlobalPromptKeys({ mode: 'text', onComplete: props.onComplete });
  useInput((input, key) => {
    if (key.return) {
      props.onComplete(selected(value === '' && props.defaultValue !== undefined
        ? props.defaultValue
        : value));
    } else if (key.backspace || key.delete) {
      setValue(removeLastGrapheme);
    } else if (input && !key.ctrl && !key.meta && input >= ' ') {
      setValue((current) => current + input);
    }
  });
  return (
    <PromptFrame title={props.message} help="Enter 完成 · Esc 取消 · Ctrl-C 退出" size={props.size}>
      <InputDisplay value={value} columns={Math.max(8, size.columns - 4)} />
    </PromptFrame>
  );
}

export function PasswordInputView(props: {
  message: string;
  size?: { columns: number; rows: number };
  onComplete: Complete<string>;
}): React.JSX.Element {
  const windowSize = useWindowSize();
  const size = props.size ?? windowSize;
  const [value, setValue] = useState('');
  useGlobalPromptKeys({ mode: 'text', onComplete: props.onComplete });
  useInput((input, key) => {
    if (key.return) props.onComplete(selected(value));
    else if (key.backspace || key.delete) setValue(removeLastGrapheme);
    else if (input && !key.ctrl && !key.meta && input >= ' ') setValue((current) => current + input);
  });
  return (
    <PromptFrame
      title={props.message}
      help="输入已隐藏 · Enter 完成 · Esc 取消 · Ctrl-C 退出"
      size={props.size}
    >
      <InputDisplay value={value} sensitive columns={Math.max(8, size.columns - 4)} />
    </PromptFrame>
  );
}
