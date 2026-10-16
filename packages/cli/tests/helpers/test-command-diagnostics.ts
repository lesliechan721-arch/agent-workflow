import childProcess from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import fs from 'fs-extra';

import { createExecFileNativeCliRunner, NativeCliError } from '../../src/utils/native-cli.js';
import { createWindowsJobInvocation, observeProcessTree } from '../../src/utils/process-tree.js';

interface CommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  onStdout?: (text: string) => void;
  onStderr?: (text: string) => void;
  maxBuffer?: number;
}

interface CommandMetrics {
  managedSpawnCount?: number;
  rootPid?: number;
  cleanupFailureCount?: number;
  leakedProcessCount?: number | null;
}

interface DiagnosticEvent {
  stage: string;
  state: 'started' | 'succeeded' | 'failed' | 'cancelled';
  elapsedMs: number;
  error?: string;
  metrics?: CommandMetrics;
}

export function sanitizeTestDiagnostic(value: string, env = process.env): string {
  let result = value;
  for (const [key, secret] of Object.entries(env)) {
    if (/(?:token|password|secret|credential|auth|api.?key)/iu.test(key) && secret && secret.length >= 4) {
      result = result.split(secret).join('[secret]');
    }
  }
  for (const key of ['HOME', 'USERPROFILE', 'TMPDIR', 'TEMP', 'TMP', 'LOCALAPPDATA']) {
    const root = env[key];
    if (root && root.length > 1) result = result.split(root).join(`[${key.toLowerCase()}]`);
  }
  return result
    .replace(/\b(?:https?|file|ssh|git):\/\/[^\s"'<>]+/giu, '[url]')
    .replace(/\b[^\s@]+@[^\s:]+:[^\s]+/gu, '[remote]')
    .replace(/\b(?:Bearer\s+|npm_)[A-Za-z0-9_.-]+/giu, '[secret]')
    .replace(/((?:_authToken|password|token|secret)\s*[=:]\s*)[^\s,;]+/giu, '$1[secret]')
    .replace(/(?:[A-Za-z]:[\\/]|\\\\)[^\s"'<>]+/gu, '[path]')
    .replace(/(?<![A-Za-z0-9_.@/\]-])\/[^\s"'<>]+/gu, '[path]');
}

function commandFailure(error: unknown, env: NodeJS.ProcessEnv, abortReason?: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error);
  const aborted = abortReason instanceof Error ? abortReason.message : String(abortReason);
  const failure = new Error(sanitizeTestDiagnostic(
    abortReason === undefined ? detail : `${aborted}; ${detail}`, env,
  ));
  // Vitest serializes error properties recursively. Keep only the fields used by these tests.
  if (error instanceof NativeCliError) {
    Object.assign(failure, {
      exitCode: error.exitCode,
      code: error.exitCode,
      stdout: sanitizeTestDiagnostic(error.stdout, env),
      stderr: sanitizeTestDiagnostic(error.stderr, env),
    });
  } else if (error && typeof error === 'object' && 'code' in error) {
    if (typeof error.code === 'number') Object.assign(failure, { code: error.code });
    else if (typeof error.code === 'string') {
      Object.assign(failure, { code: sanitizeTestDiagnostic(error.code, env) });
    }
  }
  return failure;
}

/** Only these failure-prone tests use this local scope; no process-wide runner override. */
export class TestCommandDiagnostics {
  readonly id = randomUUID();
  private readonly controller = new AbortController();
  private readonly events: DiagnosticEvent[] = [];
  private readonly active = new Map<string, number | undefined>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly env = { ...process.env };
  private readonly outputRoot: string | undefined;
  private writes = Promise.resolve();
  private warned = false;
  private sequence = 0;
  private operation: Promise<unknown> | undefined;

  constructor(
    private readonly kind: 'publisher' | 'npm',
    private readonly testName: string,
    signal?: AbortSignal,
  ) {
    const configuredRoot = this.env.AW_TEST_DIAGNOSTICS_DIR;
    if (configuredRoot && path.isAbsolute(configuredRoot)) this.outputRoot = path.join(configuredRoot, kind);
    else if (configuredRoot) this.warn('AW_TEST_DIAGNOSTICS_DIR must be an absolute path.');
    if (signal) {
      const abort = () => this.controller.abort(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      this.detachSignal = () => signal.removeEventListener('abort', abort);
      if (signal.aborted) abort();
    }
  }

  private detachSignal = (): void => {};

  run<T>(body: () => Promise<T>): Promise<T> {
    const operation = this.stage('test', body);
    this.operation = operation;
    return operation;
  }

  private warn(message: string): void {
    if (this.warned) return;
    this.warned = true;
    process.stderr.write(`[${this.kind}-diagnostics] ${message}\n`);
  }

  private save(): Promise<void> {
    if (!this.outputRoot) return Promise.resolve();
    const outputRoot = this.outputRoot;
    const snapshot = JSON.stringify({
      id: this.id,
      test: sanitizeTestDiagnostic(this.testName, this.env),
      activeCommands: [...this.active].map(([label, pid]) => ({ label, pid })),
      events: this.events,
    }, null, 2);
    this.writes = this.writes.then(async () => {
      await fs.outputFile(path.join(outputRoot, `${this.id}.json`), `${snapshot}\n`);
    }).catch((error: NodeJS.ErrnoException) => {
      this.warn(`Could not save sanitized diagnostics (${error.code ?? 'unknown error'}).`);
    });
    return this.writes;
  }

  async stage<T>(stage: string, run: () => Promise<T>): Promise<T> {
    const started = Date.now();
    const safeStage = sanitizeTestDiagnostic(stage, this.env);
    this.events.push({ stage: safeStage, state: 'started', elapsedMs: 0 });
    process.stderr.write(`[${this.kind === 'publisher' ? 'catalog-publisher' : 'pack-smoke'}] ${this.testName}: ${stage} start [${this.id}]\n`);
    await this.save();
    try {
      const result = await run();
      this.events.push({ stage: safeStage, state: 'succeeded', elapsedMs: Date.now() - started });
      return result;
    } catch (error) {
      this.events.push({
        stage: safeStage,
        state: this.controller.signal.aborted ? 'cancelled' : 'failed',
        elapsedMs: Date.now() - started,
        error: sanitizeTestDiagnostic(error instanceof Error ? error.message : String(error), this.env).slice(-16_000),
      });
      throw error;
    } finally {
      process.stderr.write(`[${this.kind === 'publisher' ? 'catalog-publisher' : 'pack-smoke'}] ${this.testName}: ${stage} end (${Date.now() - started}ms) [${this.id}]\n`);
      await this.save();
    }
  }

  command(command: string, args: string[], options: CommandOptions = {}): Promise<{ stdout: string; stderr: string }> {
    const label = `${path.basename(command)} #${++this.sequence}`;
    // A nested native runner replaces its own marker. Keep this command's ownership marker separate.
    // A unique variable also lets nested test scopes preserve their ancestors' markers.
    const markerVariable = `AW_TEST_COMMAND_${randomUUID().replaceAll('-', '_')}`;
    const marker = randomUUID();
    const metrics: CommandMetrics = {};
    const diagnosticEnv = { ...this.env, ...options.env };
    const run = this.stage(label, async () => {
      if (this.controller.signal.aborted) {
        throw commandFailure(this.controller.signal.reason, diagnosticEnv);
      }
      this.active.set(label, undefined);
      await this.save();
      try {
        const reportSpawn = (pid: number | undefined): void => {
          this.active.set(label, pid);
          void this.save();
        };
        const runner = createExecFileNativeCliRunner({
          // Build/pack can delete platform package dist while this helper is running.
          createWindowsJobInvocation: (executable, argv) => createWindowsJobInvocation(executable, argv, {
            moduleUrl: new URL('../../../agent-skill-eval/src/windows-job.ts', import.meta.url).href,
          }),
          observeProcessTree: (pid) => observeProcessTree(pid, marker, {
            markerEnvironmentVariable: markerVariable,
          }),
          execFile(executable, argv, spawnOptions, callback) {
            const child = childProcess.execFile(executable, argv, {
              ...spawnOptions,
              // npm scripts can launch cmd.exe, which rejects a namespaced cwd as UNC.
              cwd: options.cwd,
              maxBuffer: options.maxBuffer ?? 20 * 1024 * 1024,
            }, callback);
            metrics.managedSpawnCount = 1;
            metrics.rootPid = child.pid;
            reportSpawn(child.pid);
            child.stdout?.on('data', (chunk) => options.onStdout?.(String(chunk)));
            child.stderr?.on('data', (chunk) => options.onStderr?.(String(chunk)));
            return child;
          },
        });
        const result = await runner({
          command,
          args,
          cwd: options.cwd,
          env: { ...(options.env ?? process.env), [markerVariable]: marker },
          signal: this.controller.signal,
          timeoutMs: options.timeoutMs,
        });
        metrics.leakedProcessCount = 0;
        return result;
      } catch (error) {
        const cleanupError = error instanceof NativeCliError ? error.cleanupError : error;
        metrics.cleanupFailureCount = cleanupError ? 1 : 0;
        metrics.leakedProcessCount = cleanupError ? null : 0;
        throw commandFailure(error, diagnosticEnv,
          this.controller.signal.aborted ? this.controller.signal.reason : undefined);
      } finally {
        // A nonzero cleanup count means termination was not confirmed. Keep it visible.
        if (!metrics.cleanupFailureCount) this.active.delete(label);
        this.events.push({ stage: `${label} cleanup`, state: metrics.cleanupFailureCount ? 'failed' : 'succeeded', elapsedMs: 0, metrics });
      }
    });
    this.pending.add(run);
    void run.then(() => this.pending.delete(run), () => this.pending.delete(run));
    return run;
  }

  async finish(): Promise<void> {
    if (this.pending.size > 0) this.controller.abort(new Error('Test ended before its command completed.'));
    // Vitest timeout races the callback. Wait for the actual process-tree cleanup before removing fixtures.
    await Promise.allSettled([...this.pending]);
    await Promise.allSettled(this.operation ? [this.operation] : []);
    this.detachSignal();
    await this.save();
    if (this.active.size > 0) throw new Error('Managed test process cleanup is unconfirmed; temporary directories were retained.');
  }

  async npmLogs(logsDir: string, cachePath: string): Promise<void> {
    const relativeCache = path.relative(this.env.HOME ?? '', cachePath);
    const cacheInHome = path.isAbsolute(cachePath) && !path.isAbsolute(relativeCache)
      && relativeCache.split(path.sep)[0] !== '..';
    const summary: {
      id: string;
      cache: string;
      cacheLocation: string;
      cacheHits: number;
      cacheMisses: number;
      cacheRevalidated: number;
      timing: Array<{ timers: Record<string, number>; unfinishedTimers: Record<string, number[]> }>;
    } = {
      id: this.id,
      cache: sanitizeTestDiagnostic(cachePath, this.env),
      cacheLocation: !cachePath ? 'unresolved' : cacheInHome ? 'isolated-home' : 'outside-isolated-home',
      cacheHits: 0,
      cacheMisses: 0,
      cacheRevalidated: 0,
      timing: [],
    };
    try {
      for (const name of await fs.readdir(logsDir)) {
        if (name.endsWith('-debug-0.log')) {
          const content = await fs.readFile(path.join(logsDir, name), 'utf8');
          summary.cacheHits += (content.match(/\(cache hit\)/gu) ?? []).length;
          summary.cacheMisses += (content.match(/\(cache miss\)/gu) ?? []).length;
          summary.cacheRevalidated += (content.match(/\(cache revalidated\)/gu) ?? []).length;
        } else if (name.endsWith('-timing.json')) {
          const timing = await fs.readJson(path.join(logsDir, name)) as Record<string, unknown>;
          const timers: Record<string, number> = {};
          const unfinishedTimers: Record<string, number[]> = {};
          for (const [key, value] of Object.entries(timing.timers ?? {})) {
            if (typeof value === 'number' && Number.isFinite(value)) timers[sanitizeTestDiagnostic(key, this.env)] = value;
          }
          for (const [key, value] of Object.entries(timing.unfinishedTimers ?? {})) {
            if (Array.isArray(value) && value.every((item) => typeof item === 'number' && Number.isFinite(item))) {
              unfinishedTimers[sanitizeTestDiagnostic(key, this.env)] = value;
            }
          }
          summary.timing.push({ timers, unfinishedTimers });
        }
      }
      process.stderr.write(`[pack-smoke npm] ${JSON.stringify({
        id: this.id,
        cache: summary.cache,
        cacheLocation: summary.cacheLocation,
        cacheHits: summary.cacheHits,
        cacheMisses: summary.cacheMisses,
        cacheRevalidated: summary.cacheRevalidated,
        timingFiles: summary.timing.length,
        npmMs: summary.timing.map(({ timers }) => timers.npm).filter((value) => value !== undefined),
        phases: summary.timing.map(({ timers }) => Object.fromEntries([
          'command:install', 'idealTree', 'reify:loadTrees', 'reify:unpack', 'reify:build',
        ].flatMap((stage) => timers[stage] === undefined ? [] : [[stage, timers[stage]]])))
          .filter((phases) => Object.keys(phases).length > 0),
      })}\n`);
      if (this.outputRoot) await fs.outputJson(path.join(this.outputRoot, `${this.id}-npm.json`), summary, { spaces: 2 });
    } catch (error) {
      this.warn(`Could not collect sanitized npm timing (${(error as NodeJS.ErrnoException).code ?? 'invalid log'}).`);
    }
  }
}
