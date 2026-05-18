import type {
  CliPromptAction,
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
  action?: CliPromptAction;
  cancelled?: boolean;
}

export interface FakePromptCall {
  method: FakePromptMethod;
  options: unknown;
}

function toPromptResult<T>(reply: FakePromptReply): CliPromptResult<T> {
  if (reply.method === 'select' && reply.value === '__back') {
    return {
      action: 'back',
      cancelled: false,
    };
  }
  if (reply.method === 'select' && reply.value === '__exit') {
    return {
      action: 'exit',
      cancelled: false,
    };
  }
  if (reply.action && reply.action !== 'select') {
    return {
      action: reply.action,
      cancelled: reply.action === 'cancel',
    };
  }
  if (reply.cancelled) {
    return {
      action: 'cancel',
      cancelled: true,
    };
  }
  return {
    action: 'select',
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
    if (
      reply.method !== method &&
      !(method === 'select' && reply.method === 'confirm')
    ) {
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
    }) => {
      const reply = next('select', options);
      if (reply.method === 'confirm') {
        return reply.value === true
          ? toPromptResult<string>({ method: 'select', value: 'confirm-continue' })
          : {
              action: 'back',
              cancelled: false,
            };
      }
      return toPromptResult<string>(reply);
    },
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
  renderCount: number;
  lastView?: CliConsoleView;
  views: CliConsoleView[];
} {
  const views: CliConsoleView[] = [];
  return {
    views,
    renderCount: 0,
    render(view) {
      this.renderCount += 1;
      this.lastView = view;
      views.push(view);
    },
  };
}
