import { execFile } from 'node:child_process';

export interface NativeCliInvocation {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface NativeCliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface NativeCliErrorOptions {
  invocation: NativeCliInvocation;
  exitCode: number;
  stdout: string;
  stderr: string;
  cause?: unknown;
}

export class NativeCliError extends Error {
  readonly invocation: NativeCliInvocation;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;

  constructor(options: NativeCliErrorOptions) {
    const renderedArgs = options.invocation.args.join(' ');
    const detail =
      options.stderr.trim() ||
      options.stdout.trim() ||
      `Command exited with code ${options.exitCode}.`;
    super(`${options.invocation.command}${renderedArgs ? ` ${renderedArgs}` : ''}: ${detail}`);
    this.name = 'NativeCliError';
    this.invocation = options.invocation;
    this.exitCode = options.exitCode;
    this.stdout = options.stdout;
    this.stderr = options.stderr;
    this.cause = options.cause;
  }
}

export type NativeCliRunner = (
  invocation: NativeCliInvocation,
) => Promise<NativeCliResult>;

let nativeCliRunnerOverrideForTests: NativeCliRunner | null = null;

export function setNativeCliRunnerOverrideForTests(
  runner: NativeCliRunner | null,
): void {
  nativeCliRunnerOverrideForTests = runner;
}

export function getDefaultNativeCliRunner(): NativeCliRunner {
  return nativeCliRunnerOverrideForTests ?? execFileNativeCliRunner;
}

function isAbortLikeError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'name' in error &&
      (error as { name?: string }).name === 'AbortError',
  );
}

function isTimeoutLikeError(error: unknown, timeoutMs: number | undefined): boolean {
  if (!error || typeof error !== 'object' || timeoutMs === undefined) {
    return false;
  }

  const candidate = error as {
    killed?: boolean;
    message?: string;
  };
  return (
    candidate.killed === true ||
    (typeof candidate.message === 'string' && candidate.message.includes('timed out'))
  );
}

export const execFileNativeCliRunner: NativeCliRunner = async (
  invocation,
) =>
  new Promise<NativeCliResult>((resolve, reject) => {
    execFile(
      invocation.command,
      invocation.args,
      {
        cwd: invocation.cwd,
        env: invocation.env,
        timeout: invocation.timeoutMs,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({
            exitCode: 0,
            stdout,
            stderr,
          });
          return;
        }

        const exitCode =
          typeof (error as { code?: number | string }).code === 'number'
            ? ((error as { code: number }).code)
            : isAbortLikeError(error) || isTimeoutLikeError(error, invocation.timeoutMs)
              ? 124
              : 1;

        reject(
          new NativeCliError({
            invocation,
            exitCode,
            stdout,
            stderr,
            cause: error,
          }),
        );
      },
    );
  });

export async function runNativeCli(
  invocation: NativeCliInvocation,
  runner?: NativeCliRunner,
): Promise<NativeCliResult> {
  return (runner ?? getDefaultNativeCliRunner())(invocation);
}
