import { PassThrough } from 'node:stream';

import type { CliIo, CliRuntimeOptions } from '../../src/index.js';

import {
  createSafeCliRuntimeOptions,
  type SafeCliRuntimeOptions,
} from './cli-runtime.js';

export type RunCliEntryFunction = (
  argv: string[],
  options?: CliRuntimeOptions,
) => Promise<number>;

export interface CapturedCliIo {
  io: CliIo;
  readStdout: () => string;
  readStderr: () => string;
  reset: () => void;
}

export interface CliEntryResult {
  argv: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
  parseJsonStdout: <T = unknown>() => T;
}

export function createTtyRuntimeStreams(): Pick<
  CliRuntimeOptions,
  'stdin' | 'stdout' | 'promptOutputSink'
> {
  const stdin = new PassThrough() as PassThrough & { isTTY?: boolean };
  stdin.isTTY = true;
  return {
    stdin,
    stdout: { isTTY: true },
    promptOutputSink: { isTTY: true, write: () => true },
  };
}

export type RunCliEntryOptions = SafeCliRuntimeOptions & {
  runCli?: RunCliEntryFunction;
};

export function createCapturedCliIo(): CapturedCliIo {
  let stdout = '';
  let stderr = '';

  return {
    io: {
      stdout: (text: string) => {
        stdout += text;
      },
      stderr: (text: string) => {
        stderr += text;
      },
    },
    readStdout: () => stdout,
    readStderr: () => stderr,
    reset: () => {
      stdout = '';
      stderr = '';
    },
  };
}

export function parseCliJsonStdout<T = unknown>(
  stdout: string,
  context: {
    argv?: string[];
    exitCode?: number;
    stderr?: string;
  } = {},
): T {
  try {
    return JSON.parse(stdout) as T;
  } catch (error) {
    const command = context.argv ? ` for aw ${context.argv.join(' ')}` : '';
    const exitCode = context.exitCode === undefined ? '' : `\nexitCode: ${context.exitCode}`;
    const stderr = context.stderr ? `\nstderr:\n${context.stderr}` : '';
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Expected CLI stdout${command} to be parseable JSON.${exitCode}${stderr}\nstdout:\n${stdout}\nJSON.parse error: ${reason}`,
    );
  }
}

export async function runCliEntry(
  argv: string[],
  options: RunCliEntryOptions = {},
): Promise<CliEntryResult> {
  const { runCli, io: forwardedIo, ...runtimeOptions } = options;
  const safeRuntimeOptions = createSafeCliRuntimeOptions(runtimeOptions);
  const capture = createCapturedCliIo();
  const io: CliIo = {
    stdout: (text: string) => {
      capture.io.stdout(text);
      forwardedIo?.stdout?.(text);
    },
    stderr: (text: string) => {
      capture.io.stderr(text);
      forwardedIo?.stderr?.(text);
    },
  };
  const execute = runCli ?? (await import('../../src/index.js')).runCli;
  const exitCode = await execute(argv, {
    ...safeRuntimeOptions,
    io,
  });
  const stdout = capture.readStdout();
  const stderr = capture.readStderr();

  return {
    argv,
    exitCode,
    stdout,
    stderr,
    parseJsonStdout: <T = unknown>() => parseCliJsonStdout<T>(stdout, {
      argv,
      exitCode,
      stderr,
    }),
  };
}
