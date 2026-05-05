import type {
  CliConsoleDriver,
  CliConsoleView,
  CliPrompt,
  CliPromptChoice,
  CliPromptResult,
} from '../../src/commands/runtime.js';

type FakePromptMethod = 'select' | 'confirm' | 'input' | 'password';

export interface FakePromptReply {
  method: FakePromptMethod;
  value?: string | boolean;
  cancelled?: boolean;
}

export interface FakePromptCall {
  method: FakePromptMethod;
  options: unknown;
}

function toPromptResult<T>(reply: FakePromptReply): CliPromptResult<T> {
  if (reply.cancelled) {
    return { cancelled: true };
  }
  return {
    cancelled: false,
    value: reply.value as T,
  };
}

export function createFakePrompt(replies: FakePromptReply[]): CliPrompt & {
  calls: FakePromptCall[];
} {
  const queue = [...replies];
  const calls: FakePromptCall[] = [];

  function next(method: FakePromptMethod, options: unknown): FakePromptReply {
    calls.push({ method, options });
    const reply = queue.shift();
    if (!reply) {
      throw new Error(`Missing fake prompt reply for ${method}.`);
    }
    if (reply.method !== method) {
      throw new Error(`Expected fake prompt reply for ${method}, got ${reply.method}.`);
    }
    return reply;
  }

  return {
    calls,
    select: async (options: {
      message: string;
      choices: CliPromptChoice[];
      defaultValue?: string;
      pageSize?: number;
    }) => toPromptResult<string>(next('select', options)),
    confirm: async (options: {
      message: string;
      defaultValue?: boolean;
    }) => toPromptResult<boolean>(next('confirm', options)),
    input: async (options: {
      message: string;
      defaultValue?: string;
    }) => toPromptResult<string>(next('input', options)),
    password: async (options: {
      message: string;
      mask?: boolean;
    }) => toPromptResult<string>(next('password', options)),
  };
}

export function createFakeConsoleDriver(): CliConsoleDriver & {
  views: CliConsoleView[];
} {
  const views: CliConsoleView[] = [];
  return {
    views,
    render(view) {
      views.push(view);
    },
  };
}
