import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import {
  observeProcessTree,
  terminateProcessTree,
  type ProcessTreeObservation,
} from './process-tree.js';
import { getCodexHome } from './state-paths.js';

const NATIVE_CLI_TIMEOUT_ENV = 'AW_NATIVE_CLI_TIMEOUT_MS';
const DEFAULT_NATIVE_CLI_TIMEOUT_MS = 60_000;
const MIN_NATIVE_CLI_TIMEOUT_MS = 1_000;
const MAX_NATIVE_CLI_TIMEOUT_MS = 600_000;
const NATIVE_CLI_CLEANUP_TIMEOUT_MS = 4_500;
const NATIVE_CLI_PROCESS_MARKER_ENV = 'AW_NATIVE_CLI_PROCESS_MARKER';

export interface NativeCliInvocation {
  command: string;
  args: string[];
  agentKind?: 'codex' | 'claude';
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface CodexManager {
  kind: 'system' | 'aw-managed';
  version: string;
  command: string;
  argsPrefix: string[];
  runtimeRoot?: string;
}

export const SYSTEM_CODEX_MANAGER: CodexManager = {
  kind: 'system',
  version: 'unknown',
  command: 'codex',
  argsPrefix: [],
};

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
  cleanupError?: Error;
  reason?: NativeCliErrorReason;
}

export type NativeCliErrorReason = 'aborted' | 'exit' | 'timeout';

function renderNativeCliCleanupError(error: Error): string {
  return error.message
    .replace(/^Native CLI cleanup unconfirmed:\s*/u, '')
    .replace(/AW_NATIVE_CLI_PROCESS_MARKER=[^\s]+/gu, '[redacted process marker]');
}

export class NativeCliError extends Error {
  readonly invocation: NativeCliInvocation;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly reason: NativeCliErrorReason;
  readonly cleanupError?: Error;

  constructor(options: NativeCliErrorOptions) {
    const renderedArgs = options.invocation.args.join(' ');
    const detail =
      options.stderr.trim() ||
      options.stdout.trim() ||
      `Command exited with code ${options.exitCode}.`;
    const cleanupDetail = options.cleanupError
      ? ` cleanup unconfirmed: ${renderNativeCliCleanupError(options.cleanupError)}`
      : '';
    super(`${options.invocation.command}${renderedArgs ? ` ${renderedArgs}` : ''}: ${detail}${cleanupDetail}`);
    this.name = 'NativeCliError';
    this.invocation = options.invocation;
    this.exitCode = options.exitCode;
    this.stdout = options.stdout;
    this.stderr = options.stderr;
    this.reason = options.reason ?? 'exit';
    this.cleanupError = options.cleanupError;
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

function readNativeCliErrorCode(error: unknown): number | string | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }

  if ('code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'number' || typeof code === 'string') {
      return code;
    }
  }

  if ('cause' in error) {
    const cause = (error as { cause?: unknown }).cause;
    if (cause && typeof cause === 'object' && 'code' in cause) {
      const code = (cause as { code?: unknown }).code;
      if (typeof code === 'number' || typeof code === 'string') {
        return code;
      }
    }
  }

  return undefined;
}

export function isNativeCliExecutableMissingError(error: unknown): boolean {
  return readNativeCliErrorCode(error) === 'ENOENT';
}

export function isNativeCliTimeoutError(error: unknown): error is NativeCliError {
  return error instanceof NativeCliError && error.reason === 'timeout';
}

export function summarizeNativeCliFailure(error: unknown): string {
  if (error instanceof NativeCliError) {
    const output = error.stderr.trim() || error.stdout.trim();
    if (!output) {
      return error.message;
    }
    if (!error.cleanupError) {
      return output;
    }
    const cleanupDetail = renderNativeCliCleanupError(error.cleanupError);
    return `${output} cleanup unconfirmed: ${cleanupDetail}`;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
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
    message?: string;
  };
  return typeof candidate.message === 'string' && candidate.message.includes('timed out');
}

interface NativeCliOutputStream {
  on: (event: 'data', listener: (chunk: unknown) => void) => unknown;
  removeListener?: (event: 'data', listener: (chunk: unknown) => void) => unknown;
  destroy?: () => unknown;
}

interface NativeCliChildProcess {
  readonly pid?: number;
  readonly exitCode?: number | null;
  readonly signalCode?: NodeJS.Signals | null;
  kill: (signal: 'SIGTERM' | 'SIGKILL') => boolean;
  once: (event: 'spawn' | 'exit', listener: () => void) => unknown;
  stdout?: NativeCliOutputStream | null;
  stderr?: NativeCliOutputStream | null;
}

/** @internal Test-only dependency seam. It is not exported from the package entrypoint. */
interface ExecFileNativeCliRunnerDependencies {
  execFile?: (
    command: string,
    args: string[],
    options: {
      cwd?: string;
      env?: NodeJS.ProcessEnv;
      windowsHide: boolean;
    },
    callback: (error: unknown, stdout: string, stderr: string) => void,
  ) => NativeCliChildProcess;
  observeProcessTree?: typeof observeProcessTree;
  terminateProcessTree?: typeof terminateProcessTree;
}

const defaultNativeCliExecFile: NonNullable<
  ExecFileNativeCliRunnerDependencies['execFile']
> = (command, args, options, callback) =>
  execFile(command, args, options, (error, stdout, stderr) => {
    callback(error, stdout, stderr);
  });

function settleNativeCliTerminationCleanup(
  child: NativeCliChildProcess,
  terminateProcessTreeImpl: typeof terminateProcessTree,
  observation: ProcessTreeObservation | undefined,
  requireConfirmedCleanup: boolean,
): Promise<Error | undefined> {
  let directKillAttempted = false;
  const killDirectChild = (): void => {
    if (directKillAttempted) {
      return;
    }
    directKillAttempted = true;
    if (child.exitCode != null || child.signalCode != null) {
      return;
    }
    try {
      child.kill('SIGKILL');
    } catch {
      // The child can exit before fallback termination runs.
    }
  };

  if (child.pid === undefined) {
    killDirectChild();
    return Promise.resolve(
      requireConfirmedCleanup
        ? new Error('Native CLI cleanup unconfirmed: child PID is unavailable.')
        : undefined,
    );
  }
  const childPid = child.pid;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (cleanupError?: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      child.stdout?.destroy?.();
      child.stderr?.destroy?.();
      if (cleanupError) {
        killDirectChild();
      }
      resolve(cleanupError);
    };
    const timeout = setTimeout(
      () => finish(new Error('Native CLI cleanup unconfirmed: cleanup timed out.')),
      NATIVE_CLI_CLEANUP_TIMEOUT_MS,
    );
    timeout.unref();

    let cleanup: Promise<void>;
    try {
      cleanup = terminateProcessTreeImpl(
        childPid,
        () => killDirectChild(),
        {},
        { observation, requireConfirmedCleanup },
      );
    } catch (error) {
      finish(error instanceof Error
        ? error
        : new Error('Native CLI cleanup unconfirmed: cleanup threw.'));
      return;
    }
    Promise.resolve(cleanup).then(
      () => finish(),
      (error: unknown) => finish(error instanceof Error
        ? error
        : new Error('Native CLI cleanup unconfirmed: cleanup rejected.')),
    );
  });
}

function renderNativeCliOutputChunk(chunk: unknown): string {
  return Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
}

function createAbortedNativeCliError(invocation: NativeCliInvocation): NativeCliError {
  return new NativeCliError({
    invocation,
    exitCode: 1,
    stdout: '',
    stderr: '',
    cause: invocation.signal?.reason,
    reason: 'aborted',
  });
}

/** @internal Test-only factory. Production uses execFileNativeCliRunner below. */
export function createExecFileNativeCliRunner(
  dependencies: ExecFileNativeCliRunnerDependencies = {},
): NativeCliRunner {
  const execFileImpl = dependencies.execFile ?? defaultNativeCliExecFile;
  const observeProcessTreeImpl = dependencies.observeProcessTree ??
    (dependencies.terminateProcessTree ? undefined : observeProcessTree);
  const terminateProcessTreeImpl = dependencies.terminateProcessTree ?? terminateProcessTree;

  return async (invocation) => {
    if (invocation.signal?.aborted) {
      throw createAbortedNativeCliError(invocation);
    }

    return new Promise<NativeCliResult>((resolve, reject) => {
      let settled = false;
      let terminationReason: 'aborted' | 'timeout' | undefined;
      let terminationCause: unknown;
      let callbackError: unknown;
      let callbackOutput: { stdout: string; stderr: string } | undefined;
      let streamedStdout = '';
      let streamedStderr = '';
      let timeout: NodeJS.Timeout | undefined;
      let processTreeObservation: ProcessTreeObservation | undefined;
      let detachOutputListeners = (): void => {};
      const abortListener = (): void => {
        startTermination('aborted', invocation.signal?.reason);
      };

      const clearLifecycle = (): void => {
        if (timeout) {
          clearTimeout(timeout);
          timeout = undefined;
        }
        invocation.signal?.removeEventListener('abort', abortListener);
        detachOutputListeners();
        processTreeObservation?.dispose();
      };

      const resolveOnce = (result: NativeCliResult): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearLifecycle();
        resolve(result);
      };

      const rejectOnce = (error: NativeCliError): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearLifecycle();
        reject(error);
      };

      let child: NativeCliChildProcess;
      const finishTermination = (cleanupError?: Error): void => {
        if (!terminationReason) {
          return;
        }
        const output = callbackOutput ?? {
          stdout: streamedStdout,
          stderr: streamedStderr,
        };
        rejectOnce(new NativeCliError({
          invocation,
          exitCode: terminationReason === 'timeout' ? 124 : 1,
          ...output,
          cause:
            callbackError ??
            terminationCause ??
            new Error(
              terminationReason === 'timeout'
                ? `Command timed out after ${invocation.timeoutMs} ms.`
                : 'Command was aborted.',
            ),
          cleanupError,
          reason: terminationReason,
        }));
      };

      function startTermination(
        reason: 'aborted' | 'timeout',
        cause: unknown,
      ): void {
        if (settled || terminationReason) {
          return;
        }
        terminationReason = reason;
        terminationCause = cause;
        if (timeout) {
          clearTimeout(timeout);
          timeout = undefined;
        }
        Promise.resolve()
          .then(() => settleNativeCliTerminationCleanup(
            child,
            terminateProcessTreeImpl,
            processTreeObservation,
            (child.exitCode != null || child.signalCode != null) && callbackOutput === undefined,
          ))
          .then(finishTermination);
      }

      const processMarker = randomUUID();
      child = execFileImpl(
        invocation.command,
        invocation.args,
        {
          cwd: invocation.cwd,
          env: {
            ...(invocation.env ?? process.env),
            [NATIVE_CLI_PROCESS_MARKER_ENV]: processMarker,
          },
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          if (settled) {
            return;
          }
          callbackError = error;
          callbackOutput = { stdout, stderr };

          if (terminationReason) {
            return;
          }

          if (!error) {
            resolveOnce({
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

          rejectOnce(new NativeCliError({
            invocation,
            exitCode,
            stdout,
            stderr,
            cause: error,
          }));
        },
      );
      if (child.pid !== undefined) {
        processTreeObservation = observeProcessTreeImpl?.(child.pid, processMarker);
      }

      const stdoutListener = (chunk: unknown): void => {
        streamedStdout += renderNativeCliOutputChunk(chunk);
      };
      const stderrListener = (chunk: unknown): void => {
        streamedStderr += renderNativeCliOutputChunk(chunk);
      };
      child.stdout?.on('data', stdoutListener);
      child.stderr?.on('data', stderrListener);
      detachOutputListeners = () => {
        child.stdout?.removeListener?.('data', stdoutListener);
        child.stderr?.removeListener?.('data', stderrListener);
      };

      if (invocation.timeoutMs && invocation.timeoutMs > 0) {
        child.once('spawn', () => {
          if (settled || terminationReason) {
            return;
          }
          timeout = setTimeout(() => {
            startTermination('timeout', undefined);
          }, invocation.timeoutMs);
          timeout.unref();
        });
      }

      invocation.signal?.addEventListener('abort', abortListener, { once: true });
      if (invocation.signal?.aborted) {
        abortListener();
      }
    });
  };
}

export const execFileNativeCliRunner: NativeCliRunner = createExecFileNativeCliRunner();

function normalizeNativeCliCommandName(command: string): string {
  const normalizedPath = command.replaceAll('\\', '/');
  const baseName = normalizedPath.slice(normalizedPath.lastIndexOf('/') + 1).toLowerCase();
  return baseName.replace(/\.(?:bat|cmd|com|exe)$/u, '');
}

function isAgentNativeCliInvocation(invocation: NativeCliInvocation): boolean {
  if (invocation.agentKind !== undefined) {
    return true;
  }
  const commandName = normalizeNativeCliCommandName(invocation.command);
  return commandName === 'codex' || commandName === 'claude';
}

function readAgentNativeCliTimeout(env: NodeJS.ProcessEnv): number {
  const rawValue = env[NATIVE_CLI_TIMEOUT_ENV];
  if (rawValue === undefined) {
    return DEFAULT_NATIVE_CLI_TIMEOUT_MS;
  }

  if (!/^(?:0|[1-9]\d*)$/u.test(rawValue)) {
    throw new Error(
      `Invalid ${NATIVE_CLI_TIMEOUT_ENV}=${JSON.stringify(rawValue)}. Expected 0 or an integer from ${MIN_NATIVE_CLI_TIMEOUT_MS} to ${MAX_NATIVE_CLI_TIMEOUT_MS}.`,
    );
  }

  const timeoutMs = Number(rawValue);
  if (
    timeoutMs !== 0 &&
    (timeoutMs < MIN_NATIVE_CLI_TIMEOUT_MS || timeoutMs > MAX_NATIVE_CLI_TIMEOUT_MS)
  ) {
    throw new Error(
      `Invalid ${NATIVE_CLI_TIMEOUT_ENV}=${JSON.stringify(rawValue)}. Expected 0 or an integer from ${MIN_NATIVE_CLI_TIMEOUT_MS} to ${MAX_NATIVE_CLI_TIMEOUT_MS}.`,
    );
  }
  return timeoutMs;
}

function applyAgentNativeCliDefaultTimeout(
  invocation: NativeCliInvocation,
): NativeCliInvocation {
  if (!isAgentNativeCliInvocation(invocation)) {
    return invocation;
  }

  const configuredTimeoutMs = readAgentNativeCliTimeout(invocation.env ?? process.env);
  if (invocation.timeoutMs !== undefined) {
    return invocation;
  }

  return {
    ...invocation,
    timeoutMs: configuredTimeoutMs,
  };
}

export async function runNativeCli(
  invocation: NativeCliInvocation,
  runner?: NativeCliRunner,
): Promise<NativeCliResult> {
  const resolvedInvocation = applyAgentNativeCliDefaultTimeout(invocation);
  return (runner ?? getDefaultNativeCliRunner())(resolvedInvocation);
}

function buildCodexInvocation(
  manager: CodexManager,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): NativeCliInvocation {
  return {
    command: manager.command,
    args: [...manager.argsPrefix, ...args],
    agentKind: 'codex',
    cwd,
    env: {
      ...env,
      CODEX_HOME: getCodexHome(env),
    },
  };
}

export function buildCodexPluginAddInvocation(
  manager: CodexManager,
  pluginId: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): NativeCliInvocation {
  return buildCodexInvocation(manager, ['plugin', 'add', pluginId], cwd, env);
}

export function buildCodexPluginListInvocation(
  manager: CodexManager,
  cwd: string,
  env: NodeJS.ProcessEnv,
): NativeCliInvocation {
  return buildCodexInvocation(manager, ['plugin', 'list'], cwd, env);
}

export function buildCodexPluginRemoveInvocation(
  manager: CodexManager,
  pluginId: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): NativeCliInvocation {
  return buildCodexInvocation(manager, ['plugin', 'remove', pluginId], cwd, env);
}

export function buildCodexMarketplaceAddInvocation(
  manager: CodexManager,
  awHome: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): NativeCliInvocation {
  return buildCodexInvocation(manager, ['plugin', 'marketplace', 'add', awHome], cwd, env);
}

export function buildCodexMarketplaceListInvocation(
  manager: CodexManager,
  cwd: string,
  env: NodeJS.ProcessEnv,
): NativeCliInvocation {
  return buildCodexInvocation(manager, ['plugin', 'marketplace', 'list'], cwd, env);
}

export function buildCodexMarketplaceRemoveInvocation(
  manager: CodexManager,
  marketplaceName: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): NativeCliInvocation {
  return buildCodexInvocation(
    manager,
    ['plugin', 'marketplace', 'remove', marketplaceName],
    cwd,
    env,
  );
}

export async function runNativeCliChecked(
  invocation: NativeCliInvocation,
  runner?: NativeCliRunner,
): Promise<NativeCliResult> {
  const result = await runNativeCli(invocation, runner);
  if (result.exitCode !== 0) {
    throw new NativeCliError({
      invocation,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    });
  }
  return result;
}
