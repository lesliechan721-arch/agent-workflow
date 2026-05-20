import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';

export interface FakeCodexAppServerInput {
  index: number;
  raw: string;
  json?: Record<string, unknown>;
  parseError?: Error;
}

export type FakeCodexAppServerAction =
  | {
      type: 'stdout-jsonl';
      value: unknown;
      delayMs?: number;
    }
  | {
      type: 'stdout-raw';
      value: string;
      delayMs?: number;
    }
  | {
      type: 'stderr';
      value: string;
      delayMs?: number;
    }
  | {
      type: 'exit';
      code?: number | null;
      signal?: NodeJS.Signals | null;
      delayMs?: number;
    };

export interface FakeCodexAppServerStep {
  when: 'start' | 'stdin';
  match?:
    | Partial<Record<'id' | 'method', unknown>>
    | ((input: FakeCodexAppServerInput) => boolean);
  actions: FakeCodexAppServerAction[];
  repeat?: boolean;
}

export interface FakeCodexAppServerInvocation {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface FakeCodexAppServerProcess extends EventEmitter {
  stdin: Writable;
  stdout: PassThrough;
  stderr: PassThrough;
  pid: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  killed: boolean;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export interface FakeCodexAppServerHarness {
  readonly process: FakeCodexAppServerProcess;
  readonly invocations: FakeCodexAppServerInvocation[];
  readonly stdinMessages: FakeCodexAppServerInput[];
  readonly killedSignals: Array<NodeJS.Signals | number | undefined>;
  spawn(invocation: FakeCodexAppServerInvocation): FakeCodexAppServerProcess;
  createRunner(): (invocation: FakeCodexAppServerInvocation) => FakeCodexAppServerProcess;
  readStdout(): string;
  readStderr(): string;
  waitForIdle(): Promise<void>;
  waitForExit(): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

function cloneInvocation(
  invocation: FakeCodexAppServerInvocation,
): FakeCodexAppServerInvocation {
  return {
    command: invocation.command,
    args: [...invocation.args],
    cwd: invocation.cwd,
    env: invocation.env ? { ...invocation.env } : undefined,
  };
}

class FakeProcess
  extends EventEmitter
  implements FakeCodexAppServerProcess {
  readonly stdin: Writable;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid: number;

  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;

  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly onLine: (line: string) => void;
  private stdinBuffer = '';
  private exitPromiseResolve?:
    (value: { code: number | null; signal: NodeJS.Signals | null }) => void;
  readonly exitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;

  constructor(
    pid: number,
    onLine: (line: string) => void,
  ) {
    super();
    this.pid = pid;
    this.onLine = onLine;
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        this.pushStdinChunk(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
        callback();
      },
    });
    this.exitPromise = new Promise((resolve) => {
      this.exitPromiseResolve = resolve;
    });
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    if (this.exitCode !== null || this.signalCode !== null) {
      return false;
    }
    this.killed = true;
    this.finishExit(null, typeof signal === 'string' ? signal : null);
    return true;
  }

  schedule(callback: () => void, delayMs = 0): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      callback();
    }, delayMs);
    this.timers.add(timer);
  }

  pendingTimerCount(): number {
    return this.timers.size;
  }

  writeStdout(text: string): void {
    this.stdout.write(text);
  }

  writeStderr(text: string): void {
    this.stderr.write(text);
  }

  exit(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    if (this.exitCode !== null || this.signalCode !== null) {
      return;
    }
    this.finishExit(code, signal);
  }

  private pushStdinChunk(chunk: string): void {
    this.stdinBuffer += chunk;
    let newlineIndex = this.stdinBuffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = this.stdinBuffer.slice(0, newlineIndex).replace(/\r$/, '');
      this.stdinBuffer = this.stdinBuffer.slice(newlineIndex + 1);
      this.onLine(line);
      newlineIndex = this.stdinBuffer.indexOf('\n');
    }
  }

  private finishExit(code: number | null, signal: NodeJS.Signals | null): void {
    for (const timer of this.timers) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.exitCode = code;
    this.signalCode = signal;
    this.stdout.end();
    this.stderr.end();
    this.emit('exit', code, signal);
    this.emit('close', code, signal);
    this.exitPromiseResolve?.({ code, signal });
  }
}

function appendJsonl(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function matchesStep(
  step: FakeCodexAppServerStep,
  input: FakeCodexAppServerInput,
): boolean {
  if (!step.match) {
    return true;
  }
  if (typeof step.match === 'function') {
    return step.match(input);
  }
  if (!input.json) {
    return false;
  }
  return Object.entries(step.match).every(([key, value]) => input.json?.[key] === value);
}

export function createFakeCodexAppServerHarness(
  steps: FakeCodexAppServerStep[],
): FakeCodexAppServerHarness {
  const invocations: FakeCodexAppServerInvocation[] = [];
  const stdinMessages: FakeCodexAppServerInput[] = [];
  const consumedSteps = new Set<number>();
  const killedSignals: Array<NodeJS.Signals | number | undefined> = [];
  let stdoutBuffer = '';
  let stderrBuffer = '';

  const process = new FakeProcess(4242, (line) => {
    const input: FakeCodexAppServerInput = {
      index: stdinMessages.length,
      raw: line,
    };
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        input.json = parsed as Record<string, unknown>;
      }
    } catch (error) {
      input.parseError = error instanceof Error ? error : new Error(String(error));
    }
    stdinMessages.push(input);
    triggerSteps('stdin', input);
  });

  process.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk.toString('utf8');
  });
  process.stderr.on('data', (chunk) => {
    stderrBuffer += chunk.toString('utf8');
  });

  const originalKill = process.kill.bind(process);
  process.kill = (signal?: NodeJS.Signals | number): boolean => {
    killedSignals.push(signal);
    return originalKill(signal);
  };

  function triggerSteps(
    when: FakeCodexAppServerStep['when'],
    input: FakeCodexAppServerInput,
  ): void {
    steps.forEach((step, index) => {
      if (step.when !== when) {
        return;
      }
      if (!step.repeat && consumedSteps.has(index)) {
        return;
      }
      if (!matchesStep(step, input)) {
        return;
      }
      if (!step.repeat) {
        consumedSteps.add(index);
      }
      let delayCursor = 0;
      for (const action of step.actions) {
        delayCursor += action.delayMs ?? 0;
        process.schedule(() => {
          if (action.type === 'stdout-jsonl') {
            process.writeStdout(appendJsonl(action.value));
            return;
          }
          if (action.type === 'stdout-raw') {
            process.writeStdout(action.value);
            return;
          }
          if (action.type === 'stderr') {
            process.writeStderr(action.value);
            return;
          }
          process.exit(action.code ?? 0, action.signal ?? null);
        }, delayCursor);
      }
    });
  }

  const startInput: FakeCodexAppServerInput = {
    index: -1,
    raw: '',
  };

  return {
    process,
    invocations,
    stdinMessages,
    killedSignals,
    spawn(invocation) {
      invocations.push(cloneInvocation(invocation));
      triggerSteps('start', startInput);
      return process;
    },
    createRunner() {
      return (invocation) => this.spawn(invocation);
    },
    readStdout() {
      return stdoutBuffer;
    },
    readStderr() {
      return stderrBuffer;
    },
    async waitForIdle() {
      while (process.pendingTimerCount() > 0) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      await new Promise((resolve) => setImmediate(resolve));
    },
    waitForExit() {
      return process.exitPromise;
    },
  };
}
