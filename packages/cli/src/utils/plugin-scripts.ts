import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'fs-extra';
import type { CommandExecutionContext } from '../commands/runtime.js';
import type { DistributionName, NormalizedPluginManifest, PlatformName, PluginConfigValue, PluginMeta, Scope } from '../types.js';
import { redactString } from '../output/redact.js';
import {
  createWindowsJobInvocation,
  observeProcessTree,
  terminateProcessTree,
  type ProcessTreeObservation,
  type WindowsJobInvocation,
} from './process-tree.js';
import { resolveAwHome } from './paths.js';
import { resolveEffectivePluginConfig } from './plugin-config.js';
import { assertTestWritablePath } from './test-path-fence.js';
import { attachSafeOperationError } from './safe-operation-diagnostic.js';
import { collectSensitiveTokenRepresentations } from './sensitive-content.js';
export { calculateFileDigest } from './bundle-integrity.js';

export const PLUGIN_SCRIPT_TIMEOUT_DEFAULT_MS = 300_000;
export const PLUGIN_SCRIPT_TIMEOUT_MIN_MS = 1_000;
export const PLUGIN_SCRIPT_TIMEOUT_MAX_MS = 1_800_000;
const OUTPUT_LIMIT = 64 * 1024;
const WINDOWS_JOB_CLOSE_TIMEOUT_MS = 4_500;

export interface PluginScriptInvocation { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; stdin?: string }
export interface PluginProcessResult { exitCode: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; timedOut: boolean }
export interface PluginProcessRunner {
  run(invocation: PluginScriptInvocation, options: { timeoutMs: number; signal?: AbortSignal }): Promise<PluginProcessResult>;
}

interface DefaultPluginProcessRunOptions { timeoutMs: number; signal?: AbortSignal; sensitiveValues?: readonly string[] }

/** @internal Test-only dependency seam. It is not exported from the package entrypoint. */
interface DefaultPluginProcessRunnerDependencies {
  platform?: NodeJS.Platform;
  spawn?: typeof spawn;
  observeProcessTree?: typeof observeProcessTree;
  terminateProcessTree?: typeof terminateProcessTree;
  createWindowsJobInvocation?: (
    executable: string,
    args: readonly string[],
  ) => WindowsJobInvocation;
}

export async function resolveBundledPluginFilePath(options: { bundleRoot: string; pluginRelativePath: string; fieldName: string }): Promise<string> {
  const bundleRoot = await fs.realpath(options.bundleRoot);
  const relativePath = options.pluginRelativePath.startsWith('./') ? options.pluginRelativePath.slice(2) : options.pluginRelativePath;
  const entryPath = await fs.realpath(path.join(bundleRoot, relativePath));
  const relative = path.relative(bundleRoot, entryPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`${options.fieldName} resolves outside the plugin bundle root.`);
  return entryPath;
}

export function buildNodeScriptInvocation(options: { entryPath: string; cwd: string; env: NodeJS.ProcessEnv; args?: string[]; stdin?: string }): PluginScriptInvocation {
  return { command: process.execPath, args: [options.entryPath, ...(options.args ?? [])], cwd: options.cwd, env: options.env, ...(options.stdin === undefined ? {} : { stdin: options.stdin }) };
}

export function buildPluginScriptSpawnEnv(options: {
  commandEnv: NodeJS.ProcessEnv; contextPath: string; tempDir: string; plugin: { name: string; version: string };
  event: string; platform?: PlatformName; distribution?: DistributionName; scope: Scope; bundleRoot: string;
}): NodeJS.ProcessEnv {
  const input = options.commandEnv;
  const output: NodeJS.ProcessEnv = {
    AW_HOME: resolveAwHome(input), AW_CODEX_HOME: input.AW_CODEX_HOME || path.join(resolveAwHome(input), 'isolated-codex-home'),
    AW_CLAUDE_HOME: input.AW_CLAUDE_HOME || path.join(resolveAwHome(input), 'isolated-claude-home'), PATH: input.PATH ?? input.Path ?? '',
    AW_PLUGIN_CONTEXT: options.contextPath, AW_PLUGIN_ROOT: options.bundleRoot, AW_PLUGIN_NAME: options.plugin.name,
    AW_PLUGIN_VERSION: options.plugin.version, AW_PLUGIN_EVENT: options.event, AW_PLUGIN_SCOPE: options.scope,
  };
  if (options.platform) output.AW_PLUGIN_PLATFORM = options.platform;
  if (options.distribution) output.AW_PLUGIN_DISTRIBUTION = options.distribution;
  if (process.platform === 'win32') {
    output.USERPROFILE = path.join(options.tempDir, 'home'); output.TEMP = path.join(options.tempDir, 'tmp'); output.TMP = output.TEMP;
    if (input.SystemRoot) output.SystemRoot = input.SystemRoot; if (input.ComSpec) output.ComSpec = input.ComSpec;
  } else { output.HOME = path.join(options.tempDir, 'home'); output.TMPDIR = path.join(options.tempDir, 'tmp'); }
  return output;
}

export function resolvePluginScriptTimeoutMs(options: { cliTimeoutMs?: number; manifestTimeoutMs?: number }): number {
  const value = options.cliTimeoutMs ?? options.manifestTimeoutMs ?? PLUGIN_SCRIPT_TIMEOUT_DEFAULT_MS;
  if (!Number.isInteger(value) || value < PLUGIN_SCRIPT_TIMEOUT_MIN_MS || value > PLUGIN_SCRIPT_TIMEOUT_MAX_MS) throw new Error('Plugin script timeout is outside the supported range.');
  return value;
}

function collectScalarLeafTokens(value: unknown): string[] {
  if (typeof value === 'string') return value === '' ? [] : [value];
  if (typeof value === 'number' || typeof value === 'boolean') return [String(value)];
  if (value === null || typeof value !== 'object') return [];
  return Object.values(value).flatMap(collectScalarLeafTokens);
}

export function collectSensitivePluginConfigValues(manifest: NormalizedPluginManifest, values: Record<string, PluginConfigValue>): string[] {
  return Object.entries(manifest.config?.fields ?? {}).flatMap(([key, field]) => {
    const value = values[key];
    if (value === undefined) return [];
    if (field.sensitive) return collectScalarLeafTokens(value);
    if (field.type !== 'object' || typeof value !== 'object') return [];
    return Object.entries(value).flatMap(([property, childValue]) => {
      const child = field.properties?.[property]
        ?? (field.additionalProperties === false ? undefined : field.additionalProperties);
      return child?.sensitive ? collectScalarLeafTokens(childValue) : [];
    });
  });
}

export function assertNoSensitiveConfigValues(
  value: unknown,
  sensitiveValues: readonly string[],
  message: string,
): void {
  const strings: string[] = [];
  const visit = (entry: unknown): void => {
    if (typeof entry === 'string') {
      strings.push(entry);
      return;
    }
    if (Array.isArray(entry)) {
      entry.forEach(visit);
      return;
    }
    if (entry !== null && typeof entry === 'object') {
      Object.entries(entry).forEach(([key, child]) => {
        strings.push(key);
        visit(child);
      });
    }
  };
  visit(value);
  for (const representation of collectSensitiveTokenRepresentations(sensitiveValues)) {
    if (strings.some((entry) => entry.includes(representation))) throw new Error(message);
  }
}

export function assertNoSensitiveConfigInFiles(
  files: Readonly<Record<string, Buffer>>,
  sensitiveValues: readonly string[],
  message: string,
): void {
  assertNoSensitiveConfigValues(
    Object.entries(files).map(([relativePath, content]) => ({
      relativePath,
      content: content.toString('utf8'),
    })),
    sensitiveValues,
    message,
  );
}

interface SensitiveTokenMatch { start: number; end: number; replacement?: string }

function findSensitiveTokenMatches(value: string, sensitiveValue: string, startLimit: number): SensitiveTokenMatch[] {
  if (sensitiveValue === '') return [];
  const matches: SensitiveTokenMatch[] = [];
  for (let start = value.indexOf(sensitiveValue); start >= 0 && start < startLimit; start = value.indexOf(sensitiveValue, start + 1)) {
    matches.push({ start, end: start + sensitiveValue.length });
  }
  return matches;
}

function collectMergedSensitiveTokenMatches(value: string, sensitiveValues: readonly string[], startLimit: number): SensitiveTokenMatch[] {
  const matches = collectSensitiveTokenRepresentations(sensitiveValues)
    .flatMap((representation) => findSensitiveTokenMatches(value, representation, startLimit))
    .sort((left, right) => left.start - right.start || right.end - left.end);
  const merged: SensitiveTokenMatch[] = [];
  for (const match of matches) {
    const previous = merged.at(-1);
    if (previous && match.start < previous.end) {
      previous.end = Math.max(previous.end, match.end);
    } else {
      merged.push({ ...match });
    }
  }
  return merged;
}

function redactSensitiveTokenWindow(value: string, sensitiveValues: readonly string[], windowEnd: number): string {
  const matches = collectMergedSensitiveTokenMatches(value, sensitiveValues, windowEnd);
  let output = '';
  let offset = 0;
  for (const match of matches) {
    output += `${value.slice(offset, match.start)}[REDACTED]`;
    offset = Math.min(match.end, windowEnd);
  }
  return output + value.slice(offset, windowEnd);
}

export function redactPluginScriptOutput(value: string, sensitiveValues: readonly string[]): string {
  return redactString(redactSensitiveTokenWindow(value, sensitiveValues, value.length));
}
export function truncatePluginScriptOutput(value: string): string {
  return value.slice(0, OUTPUT_LIMIT);
}
export function summarizePluginScriptOutput(value: string, sensitiveValues: readonly string[]): string {
  return redactString(redactSensitiveTokenWindow(
    value,
    sensitiveValues,
    Math.min(value.length, OUTPUT_LIMIT),
  )).trim();
}

function summarizePreApplyFailureOutput(
  value: string,
  roots: ReadonlyArray<{ root: string; replacement: string }>,
  sensitiveValues: readonly string[],
): string {
  const summary = redactString(sanitizePreApplyErrorMessage(
    value,
    roots,
    sensitiveValues,
    Math.min(value.length, OUTPUT_LIMIT),
  )).trim();
  const lines = summary.split('\n').map((line) => line.trim()).filter(Boolean);
  const includesRuntimeStack = lines.some((line) =>
    line.startsWith('file://')
    || line.startsWith('at ')
    || /^Node\.js v/u.test(line));
  if (!includesRuntimeStack) return summary;
  return lines.find((line) => /^(?:[A-Za-z]*Error|Error):/u.test(line)) ?? '';
}

function resolveOutputCaptureLimit(sensitiveValues: readonly string[]): number {
  const maxSensitiveTokenLength = collectSensitiveTokenRepresentations(sensitiveValues).reduce(
    (maximum, value) => Math.max(maximum, value.length),
    0,
  );
  return OUTPUT_LIMIT + maxSensitiveTokenLength;
}

function privateRootVariants(root: string): string[] {
  const normalized = path.resolve(root);
  return [...new Set([
    normalized,
    normalized.replaceAll('\\', '/'),
    ...(normalized.startsWith('/var/') ? [`/private${normalized}`] : []),
    ...(normalized.startsWith('/private/var/') ? [normalized.slice('/private'.length)] : []),
  ])];
}

function sanitizePreApplyErrorMessage(
  value: string,
  roots: ReadonlyArray<{ root: string; replacement: string }>,
  sensitiveValues: readonly string[],
  windowEnd: number = value.length,
): string {
  const matches = [
    ...roots
      .filter(({ root }) => root.trim() !== '')
      .flatMap(({ root, replacement }) => privateRootVariants(root)
        .flatMap((variant) => findSensitiveTokenMatches(value, variant, windowEnd)
          .map((match) => ({ ...match, replacement })))),
    ...collectSensitiveTokenRepresentations(sensitiveValues)
      .flatMap((representation) => findSensitiveTokenMatches(value, representation, windowEnd)
        .map((match) => ({ ...match, replacement: '[REDACTED]' }))),
  ].sort((left, right) => left.start - right.start || right.end - left.end);
  const merged: Required<SensitiveTokenMatch>[] = [];
  for (const match of matches) {
    const previous = merged.at(-1);
    if (previous && match.start < previous.end) {
      previous.end = Math.max(previous.end, match.end);
    } else {
      merged.push({ ...match, replacement: match.replacement ?? '[REDACTED]' });
    }
  }
  let output = '';
  let offset = 0;
  for (const match of merged) {
    output += `${value.slice(offset, match.start)}${match.replacement}`;
    offset = Math.min(match.end, windowEnd);
  }
  return output + value.slice(offset, windowEnd);
}

export function createDefaultPluginProcessRunner(
  dependencies: DefaultPluginProcessRunnerDependencies = {},
) {
  const platform = dependencies.platform ?? process.platform;
  const spawnImpl = dependencies.spawn ?? spawn;
  const observeProcessTreeImpl = dependencies.observeProcessTree ?? observeProcessTree;
  const terminateProcessTreeImpl = dependencies.terminateProcessTree ?? terminateProcessTree;
  const createWindowsJobInvocationImpl = dependencies.createWindowsJobInvocation ??
    (dependencies.spawn ? undefined : createWindowsJobInvocation);
  return {
  run(invocation: PluginScriptInvocation, options: DefaultPluginProcessRunOptions): Promise<PluginProcessResult> {
    return new Promise<PluginProcessResult>((resolve, reject) => {
      options.signal?.throwIfAborted();
      const marker = randomUUID();
      const windowsJobInvocation = platform === 'win32' && createWindowsJobInvocationImpl
        ? createWindowsJobInvocationImpl(invocation.command, invocation.args)
        : undefined;
      const child = spawnImpl(windowsJobInvocation?.command ?? invocation.command, windowsJobInvocation?.args ?? invocation.args, { cwd: invocation.cwd, env: { ...invocation.env, AW_NATIVE_CLI_PROCESS_MARKER: marker }, shell: false, stdio: ['pipe', 'pipe', 'pipe'], detached: platform !== 'win32' });
      child.stdin?.end(invocation.stdin ?? '');
      let stdout = ''; let stderr = ''; let timedOut = false; let aborted = false; let settled = false; let terminating = false;
      let windowsJobCloseTimer: NodeJS.Timeout | undefined;
      const outputCaptureLimit = resolveOutputCaptureLimit(options.sensitiveValues ?? []);
      let observation: ProcessTreeObservation | undefined; if (!windowsJobInvocation && child.pid !== undefined) observation = observeProcessTreeImpl(child.pid, marker);
      const timer = setTimeout(() => { timedOut = true; terminate(); }, options.timeoutMs);
      const abort = (): void => { aborted = true; terminate(); };
      const cleanup = (): void => { clearTimeout(timer); if (windowsJobCloseTimer) clearTimeout(windowsJobCloseTimer); options.signal?.removeEventListener('abort', abort); observation?.dispose(); };
      const result = (): PluginProcessResult => ({ exitCode: child.exitCode, signal: child.signalCode, stdout, stderr, timedOut });
      const settle = (cleanupError?: unknown): void => {
        if (settled) return;
        settled = true;
        cleanup();
        if (cleanupError) {
          reject(cleanupError);
          return;
        }
        if (aborted) {
          try { options.signal?.throwIfAborted(); } catch (error) { reject(error); return; }
        }
        resolve(result());
      };
      function terminate(
        requireConfirmedCleanup: boolean = false,
        allowUnobservedWindowsProcessOnNormalCompletion: boolean = false,
      ): void {
        if (settled || terminating) return;
        terminating = true;
        clearTimeout(timer);
        const direct = (signal: 'SIGTERM' | 'SIGKILL'): void => { if (child.exitCode === null && child.signalCode === null) child.kill(signal); };
        if (windowsJobInvocation) {
          try {
            if (child.exitCode === null && child.signalCode === null && child.kill('SIGKILL') === false) {
              throw new Error('Windows Job helper did not accept termination.');
            }
          } catch (error) {
            settle(error);
            return;
          }
          windowsJobCloseTimer = setTimeout(
            () => settle(new Error('Windows Job helper exit could not be confirmed.')),
            WINDOWS_JOB_CLOSE_TIMEOUT_MS,
          );
          windowsJobCloseTimer.unref();
          return;
        }
        const termination = child.pid === undefined
          ? Promise.resolve(direct('SIGKILL'))
          : terminateProcessTreeImpl(
              child.pid,
              direct,
              {},
              {
                observation,
                requireConfirmedCleanup,
                ...(allowUnobservedWindowsProcessOnNormalCompletion
                  ? { allowUnobservedWindowsProcessOnNormalCompletion: true }
                  : {}),
              },
            );
        void Promise.resolve(termination).then(
          () => settle(),
          (error: unknown) => settle(error),
        );
      }
      child.stdout?.setEncoding('utf8'); child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => { if (stdout.length < outputCaptureLimit) stdout += chunk.slice(0, outputCaptureLimit - stdout.length); });
      child.stderr?.on('data', (chunk: string) => { if (stderr.length < outputCaptureLimit) stderr += chunk.slice(0, outputCaptureLimit - stderr.length); });
      child.on('error', (error) => { if (!settled && (!terminating || windowsJobInvocation)) settle(error); });
      const complete = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
        if (settled) return;
        if (windowsJobInvocation) {
          settle();
          return;
        }
        if (terminating) return;
        terminate(
          true,
          platform === 'win32' && exitCode === 0 && signal === null,
        );
      };
      child.on(platform === 'win32' ? 'close' : 'exit', complete);
      options.signal?.addEventListener('abort', abort, { once: true }); if (options.signal?.aborted) abort();
    });
  },
  };
}

export const defaultPluginProcessRunner = createDefaultPluginProcessRunner();

export interface PreApplyContextV1 {
  schemaVersion: 1;
  plugin: { pluginId: string; name: string; version: string; rootDir: string };
  target: { platform: PlatformName; scope: Scope; projectRoot?: string };
  config: { values: Record<string, PluginConfigValue> };
}

export async function runPreApplyScript(options: {
  plugin: PluginMeta; platform: PlatformName; scope: Scope; cwd: string; context: CommandExecutionContext;
  scriptTimeoutMs?: number; runner?: PluginProcessRunner;
}): Promise<void> {
  const declaration = options.plugin.manifest.scripts?.preApply; if (!declaration) return;
  const awHome = resolveAwHome(options.context.env);
  const codexHome = options.context.env.AW_CODEX_HOME || path.join(awHome, 'isolated-codex-home');
  const claudeHome = options.context.env.AW_CLAUDE_HOME || path.join(awHome, 'isolated-claude-home');
  let tempDir: string | undefined;
  let interruptSignal: 'SIGINT' | 'SIGTERM' | undefined;
  let interruptReason: Error | undefined;
  let sensitiveValues: string[] = [];
  let runnerCleanupConfirmed = false;
  let removeInterruptListeners: (() => void) | undefined;
  const privateRoots = (): Array<{ root: string; replacement: string }> => [
    ...(tempDir ? [
      { root: path.join(tempDir, 'home'), replacement: '[temporary-home]' },
      { root: path.join(tempDir, 'tmp'), replacement: '[temporary]' },
      { root: tempDir, replacement: '[temporary]' },
    ] : []),
    { root: codexHome, replacement: '[codex-home]' },
    { root: claudeHome, replacement: '[claude-home]' },
    { root: awHome, replacement: '[aw-home]' },
    { root: options.plugin.rootDir, replacement: '[plugin-root]' },
    { root: options.cwd, replacement: '[project-root]' },
  ];
  try {
    const entryPath = await resolveBundledPluginFilePath({ bundleRoot: options.plugin.rootDir, pluginRelativePath: declaration.path, fieldName: 'preApply script' });
    const effective = options.plugin.manifest.config?.fields
      ? await resolveEffectivePluginConfig({ sourceId: options.plugin.sourceId, sourceIdentity: options.plugin.sourceIdentity, logicalIdentity: options.plugin.catalogLogicalIdentity, pluginName: options.plugin.manifest.name, manifest: options.plugin.manifest, targetScope: options.scope, cwd: options.cwd, env: options.context.env })
      : { values: {}, issues: [] };
    if (effective.issues.length > 0) throw new Error(`preApply config is invalid for ${options.plugin.manifest.name}.`);
    const payload: PreApplyContextV1 = {
      schemaVersion: 1,
      plugin: { pluginId: options.plugin.pluginId ?? `${options.plugin.sourceId}/${options.plugin.manifest.name}`, name: options.plugin.manifest.name, version: options.plugin.manifest.version, rootDir: options.plugin.rootDir },
      target: { platform: options.platform, scope: options.scope, ...(options.scope === 'project' ? { projectRoot: options.cwd } : {}) },
      config: { values: effective.values },
    };
    const tempRoot = assertTestWritablePath(path.join(awHome, 'tmp'), 'preApply temp root'); await fs.ensureDir(tempRoot);
    tempDir = await fs.mkdtemp(path.join(tempRoot, 'plugin-pre-apply-'));
    await fs.ensureDir(path.join(tempDir, 'home')); await fs.ensureDir(path.join(tempDir, 'tmp'));
    const env = buildPluginScriptSpawnEnv({ commandEnv: options.context.env, contextPath: '', tempDir, plugin: payload.plugin, event: 'preApply', platform: options.platform, scope: options.scope, bundleRoot: options.plugin.rootDir }); delete env.AW_PLUGIN_CONTEXT;
    sensitiveValues = collectSensitivePluginConfigValues(options.plugin.manifest, effective.values);
    const invocation = buildNodeScriptInvocation({ entryPath, cwd: options.plugin.rootDir, env, stdin: `${JSON.stringify(payload)}\n` });
    const runOptions = { timeoutMs: resolvePluginScriptTimeoutMs({ cliTimeoutMs: options.scriptTimeoutMs, manifestTimeoutMs: declaration.timeoutMs }) };
    const interruptController = new AbortController();
    const handleInterrupt = (signal: 'SIGINT' | 'SIGTERM'): void => {
      if (interruptSignal) return;
      interruptSignal = signal;
      interruptReason = new Error(`preApply interrupted by ${signal}.`);
      interruptController.abort(interruptReason);
    };
    const handleSigint = (): void => handleInterrupt('SIGINT');
    const handleSigterm = (): void => handleInterrupt('SIGTERM');
    process.on('SIGINT', handleSigint);
    process.on('SIGTERM', handleSigterm);
    removeInterruptListeners = () => {
      process.removeListener('SIGINT', handleSigint);
      process.removeListener('SIGTERM', handleSigterm);
    };
    let result: PluginProcessResult | undefined;
    try {
      result = options.runner
        ? await options.runner.run(invocation, { ...runOptions, signal: interruptController.signal })
        : await defaultPluginProcessRunner.run(invocation, { ...runOptions, sensitiveValues, signal: interruptController.signal });
      runnerCleanupConfirmed = true;
    } catch (error) {
      if (interruptSignal && error === interruptReason) {
        runnerCleanupConfirmed = true;
      } else if (interruptSignal) {
        throw new Error(`preApply process cleanup failed after ${interruptSignal}.`);
      } else {
        const causeCode = error && typeof error === 'object' && 'code' in error
          && typeof error.code === 'string' ? error.code : undefined;
        const safeCauseCode = causeCode === 'ENOENT' || causeCode === 'EACCES' || causeCode === 'EPERM'
          ? causeCode : undefined;
        throw attachSafeOperationError(new Error('preApply could not start.'), {
          code: safeCauseCode === 'ENOENT' ? 'preApplyExecutableMissing' : 'preApplyStartFailed',
          stage: 'preApply',
          safeMessage: causeCode === 'ENOENT'
            ? 'The preApply executable is not available.'
            : 'The preApply process could not start.',
          ...(safeCauseCode ? {
            cause: { code: safeCauseCode, safeMessage: `Process start failed (${safeCauseCode}).` },
          } : {}),
        });
      }
    }
    if (!result) return;
    const stdout = summarizePreApplyFailureOutput(
      result.stdout,
      privateRoots(),
      sensitiveValues,
    );
    const stderr = summarizePreApplyFailureOutput(
      result.stderr,
      privateRoots(),
      sensitiveValues,
    );
    const output = [
      ...(stdout ? [`stdout: ${stdout}`] : []),
      ...(stderr ? [`stderr: ${stderr}`] : []),
    ].join('; ');
    if (result.timedOut) throw attachSafeOperationError(
      new Error(`preApply timed out.${output ? ` ${output}` : ''}`),
      {
        code: 'preApplyTimedOut',
        stage: 'preApply',
        safeMessage: 'The preApply process timed out.',
        exitCode: 124,
      },
    );
    if (result.exitCode !== 0) {
      throw attachSafeOperationError(
        new Error(`preApply failed with exit code ${result.exitCode}.${output ? ` ${output}` : ''}`),
        {
          code: 'preApplyExited',
          stage: 'preApply',
          safeMessage: 'The preApply process exited unsuccessfully.',
          ...(result.exitCode === null ? {} : { exitCode: result.exitCode }),
        },
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failure = new Error(redactString(sanitizePreApplyErrorMessage(
      message, privateRoots(), sensitiveValues,
    )));
    const diagnostic = error && typeof error === 'object' && 'operationDiagnostic' in error
      ? (error as { operationDiagnostic?: unknown }).operationDiagnostic
      : undefined;
    throw diagnostic ? Object.assign(failure, { operationDiagnostic: diagnostic }) : failure;
  } finally {
    let tempCleanupError: unknown;
    try {
      if (tempDir) await fs.remove(tempDir);
    } catch (error) {
      tempCleanupError = error;
    }
    removeInterruptListeners?.();
    if (interruptSignal) {
      if (tempCleanupError) {
        process.stderr.write(`preApply temporary directory cleanup failed after ${interruptSignal}.\n`);
        process.exit(1);
      }
      if (!runnerCleanupConfirmed) {
        process.stderr.write(`preApply process cleanup failed after ${interruptSignal}.\n`);
        process.exit(1);
      }
      process.exit(interruptSignal === 'SIGINT' ? 130 : 143);
    }
    if (tempCleanupError) {
      throw tempCleanupError;
    }
  }
}
