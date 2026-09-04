import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'fs-extra';
import type { CommandExecutionContext } from '../commands/runtime.js';
import type { DistributionName, NormalizedPluginManifest, PlatformName, PluginConfigValue, PluginMeta, Scope } from '../types.js';
import { redactString } from '../output/redact.js';
import { observeProcessTree, terminateProcessTree, type ProcessTreeObservation } from './process-tree.js';
import { resolveAwHome } from './paths.js';
import { resolveEffectivePluginConfig } from './plugin-config.js';
import { assertTestWritablePath } from './test-path-fence.js';
export { calculateFileDigest } from './bundle-integrity.js';

export const PLUGIN_SCRIPT_TIMEOUT_DEFAULT_MS = 300_000;
export const PLUGIN_SCRIPT_TIMEOUT_MIN_MS = 1_000;
export const PLUGIN_SCRIPT_TIMEOUT_MAX_MS = 1_800_000;
const OUTPUT_LIMIT = 64 * 1024;
const TOKEN_BOUNDARY_LOOKAHEAD = 2;

export interface PluginScriptInvocation { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; stdin?: string }
export interface PluginProcessResult { exitCode: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; timedOut: boolean }
export interface PluginProcessRunner {
  run(invocation: PluginScriptInvocation, options: { timeoutMs: number; signal?: AbortSignal }): Promise<PluginProcessResult>;
}

interface DefaultPluginProcessRunOptions { timeoutMs: number; signal?: AbortSignal; sensitiveValues?: readonly string[] }

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
interface SensitiveTokenMatch { start: number; end: number }

function findSensitiveTokenMatches(value: string, sensitiveValue: string, startLimit: number): SensitiveTokenMatch[] {
  if (sensitiveValue === '') return [];
  if (sensitiveValue.length >= 8 && !/^(?:true|false|-?\d+(?:\.\d+)?)$/u.test(sensitiveValue)) {
    const matches: SensitiveTokenMatch[] = [];
    for (let start = value.indexOf(sensitiveValue); start >= 0 && start < startLimit; start = value.indexOf(sensitiveValue, start + 1)) {
      matches.push({ start, end: start + sensitiveValue.length });
    }
    return matches;
  }
  const escaped = sensitiveValue.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const numeric = /^-?\d+(?:\.\d+)?$/u.test(sensitiveValue);
  const boundary = numeric ? '\\p{L}\\p{N}_.+-' : '\\p{L}\\p{N}_';
  const pattern = new RegExp(`(?<![${boundary}])${escaped}(?![${boundary}])`, 'uy');
  const matches: SensitiveTokenMatch[] = [];
  for (let start = value.indexOf(sensitiveValue); start >= 0 && start < startLimit; start = value.indexOf(sensitiveValue, start + 1)) {
    pattern.lastIndex = start;
    if (pattern.test(value)) matches.push({ start, end: start + sensitiveValue.length });
  }
  return matches;
}

function collectMergedSensitiveTokenMatches(value: string, sensitiveValues: readonly string[], startLimit: number): SensitiveTokenMatch[] {
  const matches = [...new Set(sensitiveValues)]
    .filter((sensitiveValue) => sensitiveValue !== '')
    .flatMap((sensitiveValue) => findSensitiveTokenMatches(value, sensitiveValue, startLimit))
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
  sensitiveValues: readonly string[],
): string {
  const summary = summarizePluginScriptOutput(value, sensitiveValues);
  const lines = summary.split('\n').map((line) => line.trim()).filter(Boolean);
  const includesRuntimeStack = lines.some((line) =>
    line.startsWith('file://')
    || line.startsWith('at ')
    || /^Node\.js v/u.test(line));
  if (!includesRuntimeStack) return summary;
  return lines.find((line) => /^(?:[A-Za-z]*Error|Error):/u.test(line)) ?? '';
}

function resolveOutputCaptureLimit(sensitiveValues: readonly string[]): number {
  const maxSensitiveTokenLength = sensitiveValues.reduce(
    (maximum, value) => Math.max(maximum, value.length),
    0,
  );
  // One Unicode code point can require two UTF-16 code units for the trailing token-boundary check.
  return OUTPUT_LIMIT + maxSensitiveTokenLength + TOKEN_BOUNDARY_LOOKAHEAD;
}

export const defaultPluginProcessRunner = {
  run(invocation: PluginScriptInvocation, options: DefaultPluginProcessRunOptions): Promise<PluginProcessResult> {
    return new Promise<PluginProcessResult>((resolve, reject) => {
      options.signal?.throwIfAborted();
      const marker = randomUUID();
      const child = spawn(invocation.command, invocation.args, { cwd: invocation.cwd, env: { ...invocation.env, AW_NATIVE_CLI_PROCESS_MARKER: marker }, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
      child.stdin?.end(invocation.stdin ?? '');
      let stdout = ''; let stderr = ''; let timedOut = false; let aborted = false; let settled = false; let terminating = false;
      const outputCaptureLimit = resolveOutputCaptureLimit(options.sensitiveValues ?? []);
      let observation: ProcessTreeObservation | undefined; if (child.pid !== undefined) observation = observeProcessTree(child.pid, marker);
      const timer = setTimeout(() => { timedOut = true; terminate(); }, options.timeoutMs);
      const abort = (): void => { aborted = true; terminate(); };
      const cleanup = (): void => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); observation?.dispose(); };
      const settle = (): void => { if (settled) return; settled = true; cleanup(); if (aborted) { try { options.signal?.throwIfAborted(); } catch (error) { reject(error); return; } } resolve({ exitCode: child.exitCode, signal: child.signalCode, stdout, stderr, timedOut }); };
      function terminate(): void {
        if (settled || terminating) return; terminating = true;
        const direct = (signal: 'SIGTERM' | 'SIGKILL'): void => { if (child.exitCode === null && child.signalCode === null) child.kill(signal); };
        const termination = child.pid === undefined ? Promise.resolve(direct('SIGKILL')) : terminateProcessTree(child.pid, direct, {}, { observation });
        void Promise.resolve(termination).then(settle, settle);
      }
      child.stdout?.setEncoding('utf8'); child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => { if (stdout.length < outputCaptureLimit) stdout += chunk.slice(0, outputCaptureLimit - stdout.length); });
      child.stderr?.on('data', (chunk: string) => { if (stderr.length < outputCaptureLimit) stderr += chunk.slice(0, outputCaptureLimit - stderr.length); });
      child.on('error', (error) => { if (!settled && !terminating) { settled = true; cleanup(); reject(error); } });
      child.on('close', (exitCode, signal) => {
        if (settled || terminating) return;
        if (exitCode !== 0 || signal !== null) {
          terminate();
          return;
        }
        settled = true; cleanup(); resolve({ exitCode, signal, stdout, stderr, timedOut });
      });
      options.signal?.addEventListener('abort', abort, { once: true }); if (options.signal?.aborted) abort();
    });
  },
} satisfies PluginProcessRunner;

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
  const tempRoot = assertTestWritablePath(path.join(resolveAwHome(options.context.env), 'tmp'), 'preApply temp root'); await fs.ensureDir(tempRoot);
  const tempDir = await fs.mkdtemp(path.join(tempRoot, 'plugin-pre-apply-'));
  try {
    await fs.ensureDir(path.join(tempDir, 'home')); await fs.ensureDir(path.join(tempDir, 'tmp'));
    const env = buildPluginScriptSpawnEnv({ commandEnv: options.context.env, contextPath: '', tempDir, plugin: payload.plugin, event: 'preApply', platform: options.platform, scope: options.scope, bundleRoot: options.plugin.rootDir }); delete env.AW_PLUGIN_CONTEXT;
    const sensitiveValues = collectSensitivePluginConfigValues(options.plugin.manifest, effective.values);
    const invocation = buildNodeScriptInvocation({ entryPath, cwd: options.plugin.rootDir, env, stdin: `${JSON.stringify(payload)}\n` });
    const runOptions = { timeoutMs: resolvePluginScriptTimeoutMs({ cliTimeoutMs: options.scriptTimeoutMs, manifestTimeoutMs: declaration.timeoutMs }) };
    let result: PluginProcessResult;
    try {
      result = options.runner
        ? await options.runner.run(invocation, runOptions)
        : await defaultPluginProcessRunner.run(invocation, { ...runOptions, sensitiveValues });
    } catch {
      throw new Error('preApply could not start.');
    }
    const stdout = summarizePreApplyFailureOutput(result.stdout, sensitiveValues);
    const stderr = summarizePreApplyFailureOutput(result.stderr, sensitiveValues);
    const output = [
      ...(stdout ? [`stdout: ${stdout}`] : []),
      ...(stderr ? [`stderr: ${stderr}`] : []),
    ].join('; ');
    if (result.timedOut) throw new Error(`preApply timed out.${output ? ` ${output}` : ''}`);
    if (result.exitCode !== 0) {
      throw new Error(`preApply failed with exit code ${result.exitCode}.${output ? ` ${output}` : ''}`);
    }
  } finally { await fs.remove(tempDir); }
}
