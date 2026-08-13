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

export function resolveTuiKeyAction(
  event: TuiKeyInput,
  context: TuiKeyContext,
): Exclude<CliPromptAction, 'select'> | null {
  if (event.key.ctrl && event.input.toLowerCase() === 'c') {
    return 'exit';
  }

  if (event.key.escape) {
    if (context.mode === 'menu') {
      return context.allowBack ? 'back' : 'exit';
    }
    return 'cancel';
  }

  if (context.mode !== 'menu') {
    return null;
  }

  if (context.allowBack && event.input.toLowerCase() === 'b') {
    return 'back';
  }
  if (event.input.toLowerCase() === 'q') {
    return 'exit';
  }

  return null;
}
