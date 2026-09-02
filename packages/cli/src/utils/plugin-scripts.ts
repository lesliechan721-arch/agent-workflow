import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'fs-extra';
import type { CommandExecutionContext } from '../commands/runtime.js';
import type { DistributionName, GeneratedArtifact, NormalizedPluginManifest, PlatformName, PluginConfigValue, PluginMeta, Scope } from '../types.js';
import { redactString } from '../output/redact.js';
import { observeProcessTree, terminateProcessTree, type ProcessTreeObservation } from './process-tree.js';
import { resolveAwHome } from './paths.js';
import { resolveEffectivePluginConfig } from './plugin-config.js';
import { assertTestWritablePath } from './test-path-fence.js';
export { calculateFileDigest } from './bundle-integrity.js';

export const PLUGIN_SCRIPT_TIMEOUT_DEFAULT_MS = 30_000;
export const PLUGIN_SCRIPT_TIMEOUT_MIN_MS = 1_000;
export const PLUGIN_SCRIPT_TIMEOUT_MAX_MS = 300_000;
const OUTPUT_LIMIT = 64 * 1024;

export interface PluginScriptInvocation { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; stdin?: string }
export interface PluginProcessResult { exitCode: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; timedOut: boolean }
export interface PluginProcessRunner {
  run(invocation: PluginScriptInvocation, options: { timeoutMs: number; signal?: AbortSignal }): Promise<PluginProcessResult>;
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

export function collectSensitivePluginConfigValues(manifest: NormalizedPluginManifest, values: Record<string, PluginConfigValue>): string[] {
  return Object.entries(manifest.config?.fields ?? {}).flatMap(([key, field]) => {
    const value = values[key];
    if (value === undefined) return [];
    if (field.sensitive) return typeof value === 'object' ? Object.values(value).map(String) : [String(value)];
    if (field.type !== 'object' || typeof value !== 'object') return [];
    return Object.entries(value).flatMap(([property, childValue]) => {
      const child = field.properties?.[property]
        ?? (field.additionalProperties === false ? undefined : field.additionalProperties);
      return child?.sensitive ? [String(childValue)] : [];
    });
  }).filter(Boolean);
}
export function redactPluginScriptOutput(value: string, sensitiveValues: readonly string[]): string {
  let output = redactString(value); for (const sensitiveValue of sensitiveValues) output = output.split(sensitiveValue).join('[REDACTED]'); return output;
}
export function summarizePluginScriptOutput(value: string, sensitiveValues: readonly string[]): string {
  return redactPluginScriptOutput(value.slice(0, OUTPUT_LIMIT).trim(), sensitiveValues);
}

export const defaultPluginProcessRunner: PluginProcessRunner = {
  run(invocation, options) {
    return new Promise((resolve, reject) => {
      options.signal?.throwIfAborted();
      const marker = randomUUID();
      const child = spawn(invocation.command, invocation.args, { cwd: invocation.cwd, env: { ...invocation.env, AW_NATIVE_CLI_PROCESS_MARKER: marker }, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
      child.stdin?.end(invocation.stdin ?? '');
      let stdout = ''; let stderr = ''; let timedOut = false; let aborted = false; let settled = false; let terminating = false;
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
      child.stdout?.on('data', (chunk: string) => { if (stdout.length < OUTPUT_LIMIT) stdout += chunk; });
      child.stderr?.on('data', (chunk: string) => { if (stderr.length < OUTPUT_LIMIT) stderr += chunk; });
      child.on('error', (error) => { if (!settled && !terminating) { settled = true; cleanup(); reject(error); } });
      child.on('close', (exitCode, signal) => { if (!settled && !terminating) { settled = true; cleanup(); resolve({ exitCode, signal, stdout, stderr, timedOut }); } });
      options.signal?.addEventListener('abort', abort, { once: true }); if (options.signal?.aborted) abort();
    });
  },
};

export interface PostApplyContextV1 {
  schemaVersion: 1;
  plugin: { pluginId: string; name: string; version: string; rootDir: string };
  target: { platform: PlatformName; scope: Scope; projectRoot?: string };
  config: { values: Record<string, PluginConfigValue> };
  components: Array<{ kind: string; key: string; outcome: 'created' | 'updated' | 'removed' | 'unchanged' }>;
}

export async function runPostApplyScript(options: {
  plugin: PluginMeta; platform: PlatformName; scope: Scope; cwd: string; context: CommandExecutionContext;
  artifacts: readonly GeneratedArtifact[];
  components?: PostApplyContextV1['components'];
  scriptTimeoutMs?: number; runner?: PluginProcessRunner;
}): Promise<void> {
  const declaration = options.plugin.manifest.scripts?.postApply; if (!declaration) return;
  const entryPath = await resolveBundledPluginFilePath({ bundleRoot: options.plugin.rootDir, pluginRelativePath: declaration.path, fieldName: 'postApply script' });
  const effective = options.plugin.manifest.config?.fields
    ? await resolveEffectivePluginConfig({ sourceId: options.plugin.sourceId, sourceIdentity: options.plugin.sourceIdentity, pluginName: options.plugin.manifest.name, manifest: options.plugin.manifest, cwd: options.cwd, env: options.context.env })
    : { values: {}, issues: [] };
  if (effective.issues.length > 0) throw new Error(`postApply config is invalid for ${options.plugin.manifest.name}.`);
  const payload: PostApplyContextV1 = {
    schemaVersion: 1,
    plugin: { pluginId: options.plugin.pluginId ?? `${options.plugin.sourceId}/${options.plugin.manifest.name}`, name: options.plugin.manifest.name, version: options.plugin.manifest.version, rootDir: options.plugin.rootDir },
    target: { platform: options.platform, scope: options.scope, ...(options.scope === 'project' ? { projectRoot: options.cwd } : {}) },
    config: { values: effective.values },
    components: options.components ?? (options.artifacts.length === 0
      ? [{ kind: 'target', key: `${options.platform}:${options.scope}`, outcome: 'unchanged' }]
      : options.artifacts.map((artifact) => ({ kind: artifact.kind, key: artifact.artifactKey ?? artifact.id ?? artifact.path, outcome: artifact.state === 'disabled' ? 'removed' : 'updated' }))),
  };
  const tempRoot = assertTestWritablePath(path.join(resolveAwHome(options.context.env), 'tmp'), 'postApply temp root'); await fs.ensureDir(tempRoot);
  const tempDir = await fs.mkdtemp(path.join(tempRoot, 'plugin-post-apply-'));
  try {
    await fs.ensureDir(path.join(tempDir, 'home')); await fs.ensureDir(path.join(tempDir, 'tmp'));
    const env = buildPluginScriptSpawnEnv({ commandEnv: options.context.env, contextPath: '', tempDir, plugin: payload.plugin, event: 'postApply', platform: options.platform, scope: options.scope, bundleRoot: options.plugin.rootDir }); delete env.AW_PLUGIN_CONTEXT;
    const result = await (options.runner ?? defaultPluginProcessRunner).run(buildNodeScriptInvocation({ entryPath, cwd: options.plugin.rootDir, env, stdin: `${JSON.stringify(payload)}\n` }), { timeoutMs: resolvePluginScriptTimeoutMs({ cliTimeoutMs: options.scriptTimeoutMs, manifestTimeoutMs: declaration.timeoutMs }) });
    const stderr = summarizePluginScriptOutput(result.stderr, collectSensitivePluginConfigValues(options.plugin.manifest, effective.values));
    if (result.timedOut) throw new Error(`postApply timed out. stderr: ${stderr}`);
    if (result.exitCode !== 0) throw new Error(`postApply failed with exit code ${result.exitCode}. stderr: ${stderr}`);
  } finally { await fs.remove(tempDir); }
}
