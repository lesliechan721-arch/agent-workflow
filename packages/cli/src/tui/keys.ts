import type { Key } from 'ink';

import type { CliPromptAction } from '../commands/runtime.js';

export type TuiInputMode = 'menu' | 'text' | 'confirm';

export interface TuiKeyContext {
  mode: TuiInputMode;
  allowBack?: boolean;
}

export interface TuiKeyInput {
  input: string;
  key: Pick<Key, 'ctrl' | 'escape'>;
}

export type TuiSessionNavigationKeyAction = 'home' | 'reload';
export type TuiGlobalKeyAction = TuiSessionNavigationKeyAction | 'back' | 'help' | 'exit' | 'cancel';

export interface TuiGlobalActionDefinition {
  action: TuiGlobalKeyAction;
  key: 'h' | 'H' | 'Escape' | 'b' | '?' | 'q' | 'Ctrl+C';
  menuOnly: boolean;
}

export const TUI_GLOBAL_ACTIONS = [
  { action: 'home', key: 'h', menuOnly: true },
  { action: 'reload', key: 'H', menuOnly: true },
  { action: 'back', key: 'b', menuOnly: true },
  { action: 'back', key: 'Escape', menuOnly: true },
  { action: 'help', key: '?', menuOnly: true },
  { action: 'exit', key: 'q', menuOnly: true },
  { action: 'cancel', key: 'Escape', menuOnly: false },
  { action: 'exit', key: 'Ctrl+C', menuOnly: false },
] as const satisfies readonly TuiGlobalActionDefinition[];

function registeredAction(
  action: TuiGlobalKeyAction,
  key: TuiGlobalActionDefinition['key'],
): TuiGlobalKeyAction {
  return TUI_GLOBAL_ACTIONS.find((definition) =>
    definition.action === action && definition.key === key)!.action;
}

export function resolveTuiGlobalKeyAction(
  event: TuiKeyInput,
  context: TuiKeyContext,
): TuiGlobalKeyAction | null {
  if (event.key.ctrl && event.input.toLowerCase() === 'c') return registeredAction('exit', 'Ctrl+C');
  if (event.key.escape) {
    return context.mode === 'menu' && context.allowBack
      ? registeredAction('back', 'Escape')
      : registeredAction('cancel', 'Escape');
  }
  if (context.mode !== 'menu' || event.key.ctrl) return null;
  if (event.input === 'H') return registeredAction('reload', 'H');
  if (event.input === 'h') return registeredAction('home', 'h');
  if (context.allowBack && event.input.toLowerCase() === 'b') return registeredAction('back', 'b');
  if (event.input === '?') return registeredAction('help', '?');
  if (event.input.toLowerCase() === 'q') return registeredAction('exit', 'q');
  return null;
}

export function resolveTuiSessionNavigationKey(
  event: TuiKeyInput,
  options: { characterInput: boolean },
): TuiSessionNavigationKeyAction | null {
  const action = resolveTuiGlobalKeyAction(event, {
    mode: options.characterInput ? 'text' : 'menu',
  });
  return action === 'home' || action === 'reload' ? action : null;
}

export function resolveTuiKeyAction(
  event: TuiKeyInput,
  context: TuiKeyContext,
): Exclude<CliPromptAction, 'select'> | null {
  const action = resolveTuiGlobalKeyAction(event, context);
  if (action === 'cancel' && context.mode === 'menu') return 'exit';
  if (action === 'back' || action === 'exit' || action === 'cancel') return action;
  return null;
}
