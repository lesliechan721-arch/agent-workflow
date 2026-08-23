import { spawn } from 'node:child_process';
import path from 'node:path';

import fs from 'fs-extra';

import type { CommandExecutionContext } from '../commands/runtime.js';
import type {
  GeneratedArtifact,
  PlatformName,
  DistributionName,
  PluginLifecycleEvent,
  PluginLifecycleRuntimeOs,
  PluginLifecycleScriptEntry,
  PluginManifestSource,
  PluginMeta,
  Scope,
} from '../types.js';
import {
  inferLifecycleScriptRunnerFromPath,
  PLUGIN_SCRIPT_TIMEOUT_DEFAULT_MS,
  PLUGIN_SCRIPT_TIMEOUT_MAX_MS,
  PLUGIN_SCRIPT_TIMEOUT_MIN_MS,
  resolveLifecycleScriptForOs,
} from './plugin-script-contract.js';
import {
  resolveAwHome,
} from './paths.js';
import { resolveEffectivePluginConfig } from './plugin-config.js';
import { redactString } from '../output/redact.js';
import { assertTestWritablePath } from './test-path-fence.js';
export {
  calculateFileDigest,
  calculatePluginBundleFingerprint,
} from './bundle-integrity.js';
import { calculateFileDigest } from './bundle-integrity.js';

export type LifecycleScriptTargetSource = 'currentCatalog' | 'none';

export interface LifecycleScriptTarget {
  noOp: boolean;
  source: LifecycleScriptTargetSource;
  entry?: PluginLifecycleScriptEntry;
  entryPath?: string;
  bundleRoot?: string;
  sourceManifest?: PluginManifestSource;
  manifestPath?: string;
  manifestDigest?: string;
  warnings: string[];
}

export interface ResolveLifecycleScriptTargetOptions {
  event: PluginLifecycleEvent;
  pluginName: string;
  platform: PlatformName;
  currentPlugin?: PluginMeta;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  runtimeOs?: PluginLifecycleRuntimeOs;
}

export interface LifecycleScriptContext {
  event: PluginLifecycleEvent | 'test';
  plugin: {
    name: string;
    version: string;
    rootDir: string;
    sourceId?: string;
    sourceIdentity?: string;
    pluginId?: string;
  };
  platform: PlatformName;
  scope: Scope;
  cwd: string;
  paths: {
    awHome: string;
    codexHome: string;
    claudeHome: string;
    manifestPath: string;
    configStores?: {
      user: string;
      project: string;
      projectLocal: string;
    };
  };
  config: {
    schema?: NonNullable<PluginManifestSource['config']>['schema'];
    values: Record<string, string | number | boolean>;
    sources: Record<string, string>;
    issues: unknown[];
  };
  script: {
    runner: PluginLifecycleScriptEntry['runner'];
    path: string;
    args: string[];
    source: LifecycleScriptTargetSource;
    manifestDigest: string;
  };
  artifacts: GeneratedArtifact[];
}

export interface WrittenLifecycleScriptContext {
  context: LifecycleScriptContext;
  contextPath: string;
  tempDir: string;
  sensitiveValues: string[];
  cleanup: () => Promise<void>;
}

export interface LifecycleScriptInvocation {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface LifecycleProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface LifecycleProcessRunner {
  run(invocation: LifecycleScriptInvocation, options: { timeoutMs: number }): Promise<LifecycleProcessResult>;
}

export interface RunLifecycleScriptResult {
  executed: boolean;
  target: LifecycleScriptTarget;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
}

function runtimeOs(): PluginLifecycleRuntimeOs {
  return process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux';
}

function isInsidePath(childPath: string, rootPath: string): boolean {
  const relative = path.relative(rootPath, childPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function lifecycleCodexHome(env: NodeJS.ProcessEnv): string {
  return env.AW_CODEX_HOME || path.join(resolveAwHome(env), 'isolated-codex-home');
}

function lifecycleClaudeHome(env: NodeJS.ProcessEnv): string {
  return env.AW_CLAUDE_HOME || path.join(resolveAwHome(env), 'isolated-claude-home');
}

function assertLifecycleStagingPathForTests(
  targetPath: string,
  source: string,
): string {
  return assertTestWritablePath(
    targetPath,
    source,
    '用 createIsolatedTestEnv() 生成默认 AW_HOME/TMPDIR，或通过 registerWritableStateRoot() 登记 plugin lifecycle staging 路径。',
  );
}

export async function resolveBundledPluginFilePath(options: {
  bundleRoot: string;
  pluginRelativePath: string;
  fieldName: string;
}): Promise<string> {
  const resolvedBundleRoot = await fs.realpath(options.bundleRoot);
  const resolvedPath = await fs.realpath(
    path.join(options.bundleRoot, stripDotSlash(options.pluginRelativePath)),
  );
  if (!isInsidePath(resolvedPath, resolvedBundleRoot)) {
    throw new Error(`${options.fieldName} "${options.pluginRelativePath}" resolves outside the plugin bundle root.`);
  }

  return resolvedPath;
}

async function createTargetFromPlugin(options: {
  event: PluginLifecycleEvent;
  plugin: PluginMeta;
  source: Exclude<LifecycleScriptTargetSource, 'none'>;
  runtimeOs: PluginLifecycleRuntimeOs;
  warnings?: string[];
}): Promise<LifecycleScriptTarget> {
  const selector = options.plugin.manifest.scripts?.lifecycle?.[options.event];
  if (!selector) {
    return {
      noOp: true,
      source: options.source,
      bundleRoot: options.plugin.rootDir,
      sourceManifest: options.plugin.manifest,
      manifestPath: options.plugin.manifestPath,
      manifestDigest: await calculateFileDigest(options.plugin.manifestPath),
      warnings: options.warnings ?? [],
    };
  }

  const entry = resolveLifecycleScriptForOs(selector, options.runtimeOs);
  if (!entry) {
    throw new Error(
      `Plugin "${options.plugin.manifest.name}" declares "${options.event}" lifecycle scripts, but none support ${options.runtimeOs}.`,
    );
  }

  const bundleRoot = await fs.realpath(options.plugin.rootDir);
  const entryPath = await resolveBundledPluginFilePath({
    bundleRoot,
    pluginRelativePath: entry.path,
    fieldName: 'Lifecycle script',
  });

  return {
    noOp: false,
    source: options.source,
    entry,
    entryPath,
    bundleRoot,
    sourceManifest: options.plugin.manifest,
    manifestPath: options.plugin.manifestPath,
    manifestDigest: await calculateFileDigest(options.plugin.manifestPath),
    warnings: options.warnings ?? [],
  };
}

async function resolveCurrentPlugin(
  _pluginName: string,
  currentPlugin: PluginMeta | undefined,
  _env: NodeJS.ProcessEnv,
): Promise<PluginMeta | undefined> {
  return currentPlugin;
}

function createMissingLifecycleWarning(pluginName: string, event: PluginLifecycleEvent): string {
  return `No executable ${event} lifecycle script was found for ${pluginName}; continuing cleanup without running a lifecycle script.`;
}

export async function resolveLifecycleScriptTarget(
  options: ResolveLifecycleScriptTargetOptions,
): Promise<LifecycleScriptTarget> {
  const runtime = options.runtimeOs ?? runtimeOs();
  const warnings: string[] = [];
  const currentPlugin = await resolveCurrentPlugin(
    options.pluginName,
    options.currentPlugin,
    options.env ?? process.env,
  );
  if (currentPlugin) {
    return createTargetFromPlugin({
      event: options.event,
      plugin: currentPlugin,
      source: 'currentCatalog',
      runtimeOs: runtime,
      warnings,
    });
  }
  if (options.event === 'uninstall') {
    warnings.push(createMissingLifecycleWarning(options.pluginName, options.event));
  }
  return { noOp: true, source: 'none', warnings };
}
function stripDotSlash(value: string): string {
  return value.startsWith('./') ? value.slice(2) : value;
}

function resolveAutoRunner(entry: PluginLifecycleScriptEntry): Exclude<PluginLifecycleScriptEntry['runner'], 'auto'> {
  if (entry.runner !== 'auto') {
    return entry.runner;
  }

  const runner = inferLifecycleScriptRunnerFromPath(entry.path);
  if (!runner) {
    throw new Error(`Unable to infer lifecycle script runner from "${entry.path}".`);
  }
  return runner;
}

export function quoteCmdArgument(value: string): string {
  if (value === '') {
    return '""';
  }
  if (!/[ \t"&|<>^()]/.test(value)) {
    return value;
  }

  let escaped = '"';
  let backslashes = 0;
  for (const character of value) {
    if (character === '\\') {
      backslashes += 1;
      continue;
    }
    if (character === '"') {
      escaped += '\\'.repeat(backslashes * 2 + 1);
      escaped += '"';
      backslashes = 0;
      continue;
    }
    escaped += '\\'.repeat(backslashes);
    backslashes = 0;
    escaped += character === '%' ? '%%' : character;
  }
  escaped += '\\'.repeat(backslashes * 2);
  escaped += '"';
  return escaped;
}

export function buildLifecycleScriptInvocation(options: {
  entry: PluginLifecycleScriptEntry;
  entryPath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}): LifecycleScriptInvocation {
  const runner = resolveAutoRunner(options.entry);
  const scriptArgs = options.entry.args ?? [];
  if (!scriptArgs.every((arg) => typeof arg === 'string')) {
    throw new Error('Lifecycle script args must be strings.');
  }

  if (runner === 'node') {
    return {
      command: process.execPath,
      args: [options.entryPath, ...scriptArgs],
      cwd: options.cwd,
      env: options.env,
    };
  }

  if (runner === 'sh' || runner === 'bash') {
    return {
      command: runner,
      args: [options.entryPath, ...scriptArgs],
      cwd: options.cwd,
      env: options.env,
    };
  }

  if (runner === 'pwsh' || runner === 'powershell') {
    return {
      command: runner,
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', options.entryPath, ...scriptArgs],
      cwd: options.cwd,
      env: options.env,
    };
  }

  return {
    command: 'cmd',
    args: ['/d', '/s', '/c', [options.entryPath, ...scriptArgs].map(quoteCmdArgument).join(' ')],
    cwd: options.cwd,
    env: options.env,
  };
}

function validateTimeoutMs(value: number, source: string): number {
  if (
    !Number.isInteger(value) ||
    value < PLUGIN_SCRIPT_TIMEOUT_MIN_MS ||
    value > PLUGIN_SCRIPT_TIMEOUT_MAX_MS
  ) {
    throw new Error(
      `${source} lifecycle script timeout must be an integer between ${PLUGIN_SCRIPT_TIMEOUT_MIN_MS} and ${PLUGIN_SCRIPT_TIMEOUT_MAX_MS} ms.`,
    );
  }
  return value;
}

export function resolveLifecycleScriptTimeoutMs(options: {
  cliTimeoutMs?: number;
  manifest?: PluginManifestSource;
}): number {
  if (options.cliTimeoutMs !== undefined) {
    return validateTimeoutMs(options.cliTimeoutMs, 'CLI');
  }

  const manifestTimeout = options.manifest?.scripts?.timeoutMs;
  if (manifestTimeout !== undefined) {
    return validateTimeoutMs(manifestTimeout, 'Manifest');
  }

  return PLUGIN_SCRIPT_TIMEOUT_DEFAULT_MS;
}

export function buildPluginScriptSpawnEnv(options: {
  commandEnv: NodeJS.ProcessEnv;
  contextPath: string;
  tempDir: string;
  plugin: { name: string; version: string };
  event: string;
  platform?: PlatformName;
  distribution?: DistributionName;
  scope: Scope;
  bundleRoot: string;
  runtimeOs?: PluginLifecycleRuntimeOs;
}): NodeJS.ProcessEnv {
  if ((options.platform === undefined) === (options.distribution === undefined)) {
    throw new Error('Plugin script spawn requires exactly one platform or distribution surface.');
  }
  const input = options.commandEnv;
  const runtime = options.runtimeOs ?? runtimeOs();
  const output: NodeJS.ProcessEnv = {
    AW_HOME: resolveAwHome(input),
    AW_CODEX_HOME: lifecycleCodexHome(input),
    AW_CLAUDE_HOME: lifecycleClaudeHome(input),
    PATH: input.PATH ?? input.Path ?? '',
    AW_PLUGIN_CONTEXT: options.contextPath,
    AW_PLUGIN_ROOT: options.bundleRoot,
    AW_PLUGIN_NAME: options.plugin.name,
    AW_PLUGIN_VERSION: options.plugin.version,
    AW_PLUGIN_EVENT: options.event,
    AW_PLUGIN_SCOPE: options.scope,
  };
  if (options.platform) output.AW_PLUGIN_PLATFORM = options.platform;
  if (options.distribution) output.AW_PLUGIN_DISTRIBUTION = options.distribution;

  if (runtime === 'win32') {
    output.USERPROFILE = path.join(options.tempDir, 'home');
    output.TEMP = path.join(options.tempDir, 'tmp');
    output.TMP = output.TEMP;
    if (input.SystemRoot) {
      output.SystemRoot = input.SystemRoot;
    }
    if (input.ComSpec) {
      output.ComSpec = input.ComSpec;
    }
  } else {
    output.HOME = path.join(options.tempDir, 'home');
    output.TMPDIR = path.join(options.tempDir, 'tmp');
  }

  return output;
}

export function buildLifecycleSpawnEnv(options: {
  commandEnv: NodeJS.ProcessEnv;
  contextPath: string;
  tempDir: string;
  plugin: { name: string; version: string };
  event: PluginLifecycleEvent | 'test';
  platform: PlatformName;
  scope: Scope;
  bundleRoot: string;
  runtimeOs?: PluginLifecycleRuntimeOs;
}): NodeJS.ProcessEnv {
  return buildPluginScriptSpawnEnv(options);
}

export function collectSensitivePluginConfigValues(
  manifest: PluginManifestSource,
  values: Record<string, string | number | boolean>,
): string[] {
  const schema = manifest.config?.schema ?? {};
  return Object.entries(schema)
    .filter(([, field]) => field.sensitive)
    .map(([key]) => values[key])
    .filter((value) => value !== undefined)
    .map((value) => String(value))
    .filter((value) => value.length > 0);
}

export function redactPluginScriptOutput(value: string, sensitiveValues: readonly string[]): string {
  let output = redactString(value);
  for (const sensitiveValue of sensitiveValues) {
    output = output.split(sensitiveValue).join('[REDACTED]');
  }
  return output;
}

export function summarizePluginScriptOutput(
  value: string,
  sensitiveValues: readonly string[],
): string {
  const normalized = value.trim().slice(0, 4000);
  return redactPluginScriptOutput(normalized, sensitiveValues);
}

export async function writeLifecycleScriptContext(options: {
  sourceId?: string;
  sourceIdentity?: string;
  target: LifecycleScriptTarget;
  event: PluginLifecycleEvent | 'test';
  platform: PlatformName;
  scope: Scope;
  cwd: string;
  commandEnv: NodeJS.ProcessEnv;
  artifacts?: GeneratedArtifact[];
}): Promise<WrittenLifecycleScriptContext> {
  if ((options.sourceId === undefined) !== (options.sourceIdentity === undefined)) {
    throw new Error('Lifecycle script context requires a complete source identity.');
  }
  if (options.target.noOp || !options.target.entry || !options.target.entryPath || !options.target.bundleRoot || !options.target.sourceManifest || !options.target.manifestPath || !options.target.manifestDigest) {
    throw new Error('Cannot write lifecycle script context for a no-op target.');
  }

  let config: LifecycleScriptContext['config'] = {
    schema: options.target.sourceManifest.config?.schema,
    values: {},
    sources: {},
    issues: [],
  };
  let configStores: NonNullable<LifecycleScriptContext['paths']['configStores']> | undefined;
  if (options.target.sourceManifest.config?.schema) {
    const effective = await resolveEffectivePluginConfig({
      sourceId: options.sourceId,
      sourceIdentity: options.sourceIdentity,
      pluginName: options.target.sourceManifest.name,
      manifest: options.target.sourceManifest,
      cwd: options.cwd,
      env: options.commandEnv,
    });
    if (effective.issues.length > 0) {
      throw new Error(
        `Invalid AW config for ${options.target.sourceManifest.name}: ${effective.issues.map((issue) => `${issue.key} (${issue.type})`).join(', ')}.`,
      );
    }
    configStores = {
      user: effective.stores.user.path,
      project: effective.stores.project.path,
      projectLocal: effective.stores.projectLocal.path,
    };
    config = {
      schema: options.target.sourceManifest.config.schema,
      values: effective.values,
      sources: effective.sources,
      issues: effective.issues,
    };
  }

  const context: LifecycleScriptContext = {
    event: options.event,
    plugin: {
      name: options.target.sourceManifest.name,
      version: options.target.sourceManifest.version,
      rootDir: options.target.bundleRoot,
      ...(options.sourceId ? {
        sourceId: options.sourceId,
        sourceIdentity: options.sourceIdentity,
        pluginId: `${options.sourceId}/${options.target.sourceManifest.name}`,
      } : {}),
    },
    platform: options.platform,
    scope: options.scope,
    cwd: options.cwd,
    paths: {
      awHome: resolveAwHome(options.commandEnv),
      codexHome: lifecycleCodexHome(options.commandEnv),
      claudeHome: lifecycleClaudeHome(options.commandEnv),
      manifestPath: options.target.manifestPath,
      ...(configStores ? { configStores } : {}),
    },
    config,
    script: {
      runner: options.target.entry.runner,
      path: options.target.entryPath,
      args: options.target.entry.args ?? [],
      source: options.target.source,
      manifestDigest: options.target.manifestDigest,
    },
    artifacts: options.artifacts ?? [],
  };

  const tempRoot = assertLifecycleStagingPathForTests(
    path.join(resolveAwHome(options.commandEnv), 'tmp'),
    'plugin lifecycle temp root',
  );
  await fs.ensureDir(tempRoot);
  const tempDir = await fs.mkdtemp(
    assertLifecycleStagingPathForTests(
      path.join(tempRoot, 'plugin-script-'),
      'plugin lifecycle context temp dir',
    ),
  );
  const contextPath = assertLifecycleStagingPathForTests(
    path.join(tempDir, 'context.json'),
    'plugin lifecycle context file',
  );
  await fs.writeJson(contextPath, context, { spaces: 2 });
  try {
    await fs.chmod(contextPath, 0o600);
  } catch {
    // Best effort on non-POSIX filesystems.
  }

  return {
    context,
    contextPath,
    tempDir,
    sensitiveValues: collectSensitivePluginConfigValues(options.target.sourceManifest, config.values),
    cleanup: async () => {
      await fs.remove(tempDir);
    },
  };
}

export const defaultPluginProcessRunner: LifecycleProcessRunner = {
  run(invocation, options) {
    return new Promise((resolve, reject) => {
      const child = spawn(invocation.command, invocation.args, {
        cwd: invocation.cwd,
        env: invocation.env,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
      }, options.timeoutMs);

      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.stderr?.on('data', (chunk: string) => {
        stderr += chunk;
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (exitCode, signal) => {
        clearTimeout(timer);
        resolve({ exitCode, signal, stdout, stderr, timedOut });
      });
    });
  },
};

async function emitLifecycleEvent(
  context: CommandExecutionContext,
  event: {
    type: string;
    message?: string;
    data?: Record<string, unknown>;
    level?: 'info' | 'warning' | 'debug';
    plugin?: string;
    platform: PlatformName;
    scope: Scope;
  },
): Promise<void> {
  const commandEvent = {
    type: event.type,
    message: event.message,
    data: event.data,
    level: event.level,
    source: {
      plugin: event.plugin,
      platform: event.platform,
      scope: event.scope,
      action: 'lifecycle',
    },
  };
  await context.reporter.event(commandEvent);
  await context.debugLogger.log(commandEvent);
}

export async function runLifecycleScript(options: {
  event: PluginLifecycleEvent;
  pluginName: string;
  platform: PlatformName;
  scope: Scope;
  cwd: string;
  context: CommandExecutionContext;
  currentPlugin?: PluginMeta;
  artifacts?: GeneratedArtifact[];
  scriptTimeoutMs?: number;
  runner?: LifecycleProcessRunner;
  runtimeOs?: PluginLifecycleRuntimeOs;
}): Promise<RunLifecycleScriptResult> {
  const target = await resolveLifecycleScriptTarget({
    event: options.event,
    pluginName: options.pluginName,
    platform: options.platform,
    currentPlugin: options.currentPlugin,
    cwd: options.cwd,
    env: options.context.env,
    runtimeOs: options.runtimeOs,
  });

  for (const warning of target.warnings) {
    await options.context.reporter.notice({
      level: 'warning',
      message: warning,
      source: {
        platform: options.platform,
        plugin: options.pluginName,
        scope: options.scope,
        action: 'lifecycle',
      },
      target: 'stderr',
    });
  }

  if (target.noOp) {
    await emitLifecycleEvent(options.context, {
      type: 'lifecycle.noop',
      message: `${options.event} lifecycle script is not declared.`,
      plugin: options.pluginName,
      platform: options.platform,
      scope: options.scope,
      level: 'debug',
    });
    return { executed: false, target };
  }

  const writtenContext = await writeLifecycleScriptContext({
    sourceId: options.currentPlugin?.sourceId,
    sourceIdentity: options.currentPlugin?.sourceIdentity,
    target,
    event: options.event,
    platform: options.platform,
    scope: options.scope,
    cwd: options.cwd,
    commandEnv: options.context.env,
    artifacts: options.artifacts,
  });

  try {
    await fs.ensureDir(path.join(writtenContext.tempDir, 'home'));
    await fs.ensureDir(path.join(writtenContext.tempDir, 'tmp'));
    const timeoutMs = resolveLifecycleScriptTimeoutMs({
      cliTimeoutMs: options.scriptTimeoutMs,
      manifest: target.sourceManifest,
    });
    const spawnEnv = buildLifecycleSpawnEnv({
      commandEnv: options.context.env,
      contextPath: writtenContext.contextPath,
      tempDir: writtenContext.tempDir,
      plugin: writtenContext.context.plugin,
      event: options.event,
      platform: options.platform,
      scope: options.scope,
      bundleRoot: writtenContext.context.plugin.rootDir,
      runtimeOs: options.runtimeOs,
    });
    const invocation = buildLifecycleScriptInvocation({
      entry: target.entry!,
      entryPath: target.entryPath!,
      cwd: options.cwd,
      env: spawnEnv,
    });

    await emitLifecycleEvent(options.context, {
      type: 'lifecycle.start',
      plugin: options.pluginName,
      platform: options.platform,
      scope: options.scope,
      level: 'info',
      data: {
        event: options.event,
        source: target.source,
        command: invocation.command,
        args: invocation.args,
        timeoutMs,
      },
    });

    const result = await (options.runner ?? defaultPluginProcessRunner).run(invocation, { timeoutMs });
    const stdoutSummary = summarizePluginScriptOutput(result.stdout, writtenContext.sensitiveValues);
    const stderrSummary = summarizePluginScriptOutput(result.stderr, writtenContext.sensitiveValues);
    await emitLifecycleEvent(options.context, {
      type: 'lifecycle.finish',
      plugin: options.pluginName,
      platform: options.platform,
      scope: options.scope,
      level: result.exitCode === 0 && !result.timedOut ? 'info' : 'warning',
      data: {
        event: options.event,
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
        stdout: stdoutSummary,
        stderr: stderrSummary,
      },
    });

    if (result.timedOut) {
      throw new Error(`Lifecycle script "${options.event}" timed out after ${timeoutMs} ms. stderr: ${stderrSummary}`);
    }
    if (result.exitCode !== 0) {
      throw new Error(`Lifecycle script "${options.event}" failed with exit code ${result.exitCode}. stderr: ${stderrSummary}`);
    }

    return {
      executed: true,
      target,
      exitCode: result.exitCode,
      signal: result.signal,
      stdout: stdoutSummary,
      stderr: stderrSummary,
      timedOut: result.timedOut,
    };
  } finally {
    await writtenContext.cleanup();
  }
}
