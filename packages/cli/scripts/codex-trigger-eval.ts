import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

import fs from 'fs-extra';

import {
  assertProcessTreeInspectionAvailable,
  releaseChildProcessHandles,
  terminateChildProcessTree,
} from './codex-eval-process-tree.js';
import {
  assertCodexEvalCanStartWork,
  applyCodexEvalProviderEnvironment,
  cleanCodexEvalRuntimeConfig,
  codexEvalRuntimeEvidence,
  createCodexEvalTemporaryRoot,
  materializeCodexEvalRuntimeHome,
  redactCodexEvalValue,
  registerCodexEvalSignalCleanup,
  type CodexEvalRuntimeConfig,
} from './codex-eval-runtime-config.js';
import {
  PLUGIN_EVAL_SCHEMA_VERSION,
  readPluginEvalTriggerCases,
  type PluginEvalSplit,
  type PluginEvalSuiteReport,
  type PluginEvalTriggerCase,
  type PluginEvalTriggerSuite,
} from './plugin-eval-contract.js';

const execFileAsync = promisify(execFile);
const PASS_THRESHOLD = 0.5;
const PASSTHROUGH_ENV = new Set([
  'PATH',
  'LANG',
  'LC_ALL',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
]);
const PROTECTED_ENV = new Set([
  'HOME',
  'USERPROFILE',
  'CODEX_HOME',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_STATE_HOME',
  'TMPDIR',
  'TEMP',
  'TMP',
  'PATH',
]);

interface TriggerFixtureContext {
  workspaceRoot: string;
  evalCase: PluginEvalTriggerCase;
  env: NodeJS.ProcessEnv;
}

interface TriggerFixtureSetupResult {
  environment?: Record<string, string>;
}

interface TriggerFixtureModule {
  setupTriggerWorkspace(
    context: TriggerFixtureContext,
  ): Promise<TriggerFixtureSetupResult | void> | TriggerFixtureSetupResult | void;
  captureTriggerWorkspaceState?(
    context: TriggerFixtureContext,
  ): Promise<unknown> | unknown;
}

interface TriggerObservation {
  loaded: boolean;
  spawned: boolean;
  loadEvidence: string | null;
  spawnEvidence: string | null;
}

export interface TriggerRunEvidence {
  loaded: boolean;
  spawned: boolean;
  load_evidence: string | null;
  spawn_evidence: string | null;
  spawn_calls: Array<Record<string, unknown>>;
  termination: string;
  exit_code: number | null;
  signal: NodeJS.Signals | null;
  execution_error: boolean;
  fixture_unchanged: boolean;
  stderr?: string;
  final_message: string | null;
  duration_ms: number;
  usage: unknown;
  event_trace: unknown[];
  diagnostics: string[];
}

interface TriggerCaseSummary {
  id: string;
  split: PluginEvalTriggerCase['split'];
  query: string;
  expected: {
    load_skill: boolean;
    spawn_agent?: boolean;
  };
  observed: {
    load_rate: number;
    spawn_rate?: number;
    execution_errors: number;
  };
  complete: boolean;
  passed: boolean;
  runs: TriggerRunEvidence[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sha256(value: string | Buffer): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  if (isRecord(value)) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function buildIsolatedEnv(
  sourceEnv: NodeJS.ProcessEnv,
  runRoot: string,
  codexHome: string,
  runtime: CodexEvalRuntimeConfig,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of PASSTHROUGH_ENV) {
    if (sourceEnv[name] !== undefined) {
      env[name] = sourceEnv[name];
    }
  }
  const home = path.join(runRoot, 'home');
  const temp = path.join(runRoot, 'tmp');
  return applyCodexEvalProviderEnvironment({
    ...env,
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: codexHome,
    XDG_CACHE_HOME: path.join(runRoot, 'xdg-cache'),
    XDG_CONFIG_HOME: path.join(runRoot, 'xdg-config'),
    XDG_STATE_HOME: path.join(runRoot, 'xdg-state'),
    TMPDIR: temp,
    TEMP: temp,
    TMP: temp,
    NO_COLOR: '1',
  }, runtime);
}

async function snapshotWorkspace(root: string): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  async function visit(current: string): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name === '.git') {
        continue;
      }
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath);
      } else if (entry.isFile()) {
        const relativePath = path.relative(root, absolutePath).split(path.sep).join('/');
        snapshot[relativePath] = sha256(await fs.readFile(absolutePath));
      }
    }
  }
  await visit(root);
  return snapshot;
}

function explicitSkillRequested(query: string, skillName: string): boolean {
  const escaped = skillName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`(?:^|\\s)\\$${escaped}(?:\\s|$)`, 'u').test(query);
}

export function parseTriggerExecEventLine(line: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(line);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function eventItem(event: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!event || !['item.started', 'item.completed', 'item.updated'].includes(String(event.type))) {
    return null;
  }
  return isRecord(event.item) ? event.item : null;
}

function normalizedCommandReadsSkill(command: string, skillPath: string): boolean {
  const normalize = (value: string): string => {
    let normalized = value.replaceAll('\\', '/').replaceAll('"', '').replaceAll("'", '');
    for (let index = 0; index < 3; index += 1) {
      normalized = normalized.replace(/(^|[\s/])\.\/(?=\S)/gu, '$1');
    }
    return normalized;
  };
  const normalized = normalize(command);
  if (!/(?:^|[\s;&|/])(?:cat|sed|head|tail|less|more|bat|awk|grep|rg|type|get-content)\b/iu.test(
    normalized,
  )) {
    return false;
  }
  const normalizedSkillPath = normalize(skillPath);
  const normalizedSkillDir = path.posix.dirname(normalizedSkillPath);
  const managedSkillDir = `.agents/skills/${path.basename(path.dirname(skillPath))}`;
  if (
    normalized.includes(normalizedSkillPath) ||
    normalized.includes(`${managedSkillDir}/SKILL.md`)
  ) {
    return true;
  }
  return (
    (normalized.includes(normalizedSkillDir) || normalized.includes(managedSkillDir)) &&
    /(?:^|[\s;&|/])SKILL\.md(?:$|[\s;&|])/u.test(normalized)
  );
}

export function inspectTriggerExecEvent(
  event: Record<string, unknown> | null,
  skillPath: string,
): Partial<TriggerObservation> & { finalMessage?: string; usage?: unknown } {
  const item = eventItem(event);
  if (item?.type === 'command_execution' && typeof item.command === 'string') {
    const completed = event?.type === 'item.completed';
    const statusPassed = item.status === undefined || item.status === 'completed';
    const exitPassed = item.exit_code === undefined || item.exit_code === 0;
    if (
      completed &&
      statusPassed &&
      exitPassed &&
      normalizedCommandReadsSkill(item.command, skillPath)
    ) {
      return { loaded: true, loadEvidence: item.command };
    }
  }
  if (item?.type === 'collab_tool_call' && item.tool === 'spawn_agent') {
    return {
      spawned: true,
      spawnEvidence: typeof item.prompt === 'string' ? item.prompt : 'spawn_agent',
    };
  }
  if (item?.type === 'agent_message' && typeof item.text === 'string') {
    return { finalMessage: item.text };
  }
  if (event?.type === 'turn.completed' && event.usage !== undefined) {
    return { usage: event.usage };
  }
  return {};
}

async function listFilesRecursively(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  });
  const nested = await Promise.all(entries.map(async (entry) => {
    const candidate = path.join(root, entry.name);
    return entry.isDirectory() ? listFilesRecursively(candidate) : [candidate];
  }));
  return nested.flat();
}

function parseSpawnCall(
  line: string,
  rolloutFile: string,
  codexHome: string,
): Record<string, unknown> | null {
  const event = parseTriggerExecEventLine(line);
  const payload = event?.type === 'response_item' && isRecord(event.payload)
    ? event.payload
    : null;
  if (payload?.type !== 'function_call' || payload.name !== 'spawn_agent') {
    return null;
  }
  let args: unknown = payload.arguments;
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch {
      args = null;
    }
  }
  return {
    call_id: typeof payload.call_id === 'string' ? payload.call_id : null,
    namespace: typeof payload.namespace === 'string' ? payload.namespace : null,
    arguments: isRecord(args) ? args : null,
    rollout_file: path.relative(codexHome, rolloutFile).split(path.sep).join('/'),
  };
}

export async function readTriggerSpawnCalls(
  codexHome: string,
): Promise<Array<Record<string, unknown>>> {
  const files = (await listFilesRecursively(path.join(codexHome, 'sessions')))
    .filter((file) => file.endsWith('.jsonl'))
    .sort((left, right) => left.localeCompare(right));
  const calls: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  for (const file of files) {
    const content = await fs.readFile(file, 'utf8');
    for (const line of content.split('\n')) {
      const call = parseSpawnCall(line, file, codexHome);
      if (!call) {
        continue;
      }
      const identity = typeof call.call_id === 'string'
        ? call.call_id
        : `${String(call.rollout_file)}:${calls.length}`;
      if (!seen.has(identity)) {
        seen.add(identity);
        calls.push(call);
      }
    }
  }
  return calls;
}

function resolveCodexExecutable(codexBin: string): string {
  if (process.platform !== 'win32') {
    return codexBin;
  }
  if (!codexBin.toLowerCase().endsWith('.exe') || !path.win32.isAbsolute(codexBin)) {
    throw new Error(
      'On Windows, --codex-bin must be an absolute path to the native codex.exe.',
    );
  }
  return codexBin;
}

function buildCodexArgs(options: {
  suite: PluginEvalTriggerSuite;
  evalCase: PluginEvalTriggerCase;
  workspaceRoot: string;
  model?: string;
  modelProvider: string;
  sensitiveEnvironmentNames: string[];
}): string[] {
  const args = ['exec', '--json'];
  if (options.suite.isolation === 'strict') {
    args.push('--ephemeral', '--strict-config');
  }
  if (!options.evalCase.use_project_rules) {
    args.push('--ignore-rules');
  }
  args.push(
    '--skip-git-repo-check',
    '--color',
    'never',
    '--sandbox',
    'read-only',
    '--cd',
    options.workspaceRoot,
    '--config',
    'skills.include_instructions=true',
    '--config',
    `shell_environment_policy.exclude=${JSON.stringify([
      'CODEX_HOME',
      ...options.sensitiveEnvironmentNames,
    ])}`,
    '--config',
    `model_provider=${JSON.stringify(options.modelProvider)}`,
  );
  if (options.suite.isolation === 'strict') {
    args.push(
      '--config',
      'skills.bundled.enabled=false',
      '--config',
      'orchestrator.skills.enabled=false',
      '--config',
      'orchestrator.mcp.enabled=false',
      '--config',
      'include_apps_instructions=false',
      '--config',
      'include_collaboration_mode_instructions=false',
    );
  }
  if (options.suite.observeSpawnAgent) {
    args.push(
      '--enable',
      'multi_agent',
      '--config',
      'features.multi_agent_v2.enabled=true',
      '--config',
      'features.multi_agent_v2.hide_spawn_agent_metadata=false',
    );
  }
  if (options.model) {
    args.push('--model', options.model);
  }
  args.push(options.evalCase.query);
  return args;
}

function expectedEarlyStop(
  suite: PluginEvalTriggerSuite,
  evalCase: PluginEvalTriggerCase,
  observed: TriggerObservation,
): string | null {
  if (!evalCase.should_load_skill && observed.loaded) {
    return 'unexpected_skill_load';
  }
  if (suite.observeSpawnAgent && !evalCase.should_spawn_agent && observed.spawned) {
    return 'unexpected_spawn';
  }
  if (!suite.observeSpawnAgent && evalCase.should_load_skill && observed.loaded) {
    return 'expected_skill_load';
  }
  if (
    suite.observeSpawnAgent &&
    evalCase.should_load_skill &&
    evalCase.should_spawn_agent &&
    observed.loaded &&
    observed.spawned
  ) {
    return 'expected_outcome_observed';
  }
  return null;
}

async function loadFixtureModule(
  pluginRoot: string,
  suite: PluginEvalTriggerSuite,
): Promise<TriggerFixtureModule | null> {
  if (!suite.fixtureModule) {
    return null;
  }
  const modulePath = path.resolve(pluginRoot, suite.fixtureModule.replace(/^\.\//u, ''));
  const loaded = await import(pathToFileURL(modulePath).href) as Partial<TriggerFixtureModule>;
  if (typeof loaded.setupTriggerWorkspace !== 'function') {
    throw new Error(
      `Trigger fixture module for suite "${suite.id}" must export setupTriggerWorkspace().`,
    );
  }
  return loaded as TriggerFixtureModule;
}

function mergeFixtureEnvironment(
  baseEnv: NodeJS.ProcessEnv,
  result: TriggerFixtureSetupResult | void,
): NodeJS.ProcessEnv {
  if (!result?.environment) {
    return baseEnv;
  }
  if (!isRecord(result.environment)) {
    throw new Error('Trigger fixture environment must be an object.');
  }
  const additions: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(result.environment)) {
    if (PROTECTED_ENV.has(name)) {
      throw new Error(`Trigger fixture cannot override protected environment variable ${name}.`);
    }
    if (typeof value !== 'string') {
      throw new Error(`Trigger fixture environment variable ${name} must be a string.`);
    }
    additions[name] = value;
  }
  return { ...baseEnv, ...additions };
}

function protectedEnvironmentSnapshot(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  return Object.fromEntries([...PROTECTED_ENV].map((name) => [name, env[name]]));
}

function assertProtectedEnvironmentUnchanged(
  env: NodeJS.ProcessEnv,
  before: Record<string, string | undefined>,
): void {
  for (const [name, value] of Object.entries(before)) {
    if (env[name] !== value) {
      throw new Error(`Trigger fixture cannot mutate protected environment variable ${name}.`);
    }
  }
}

async function captureState(
  fixture: TriggerFixtureModule | null,
  context: TriggerFixtureContext,
): Promise<unknown> {
  const state = fixture?.captureTriggerWorkspaceState
    ? await fixture.captureTriggerWorkspaceState(context)
    : await snapshotWorkspace(context.workspaceRoot);
  if (state === undefined || stableJson(state) === undefined) {
    throw new Error('Trigger fixture state must be JSON-serializable.');
  }
  return state;
}

function strictSystemCodexRoot(sourceEnv: NodeJS.ProcessEnv): string {
  if (process.platform === 'win32') {
    return path.join(
      sourceEnv.ProgramData ?? String.raw`C:\ProgramData`,
      'OpenAI',
      'Codex',
    );
  }
  return '/etc/codex';
}

async function assertStrictSystemConfigAbsent(sourceEnv: NodeJS.ProcessEnv): Promise<void> {
  const systemRoot = strictSystemCodexRoot(sourceEnv);
  const entries = await fs.readdir(systemRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  });
  if (entries.length > 0) {
    throw new Error(
      `Refusing strict trigger eval because Codex system configuration exists at ${systemRoot}.`,
    );
  }
}

async function runTriggerOnce(options: {
  suite: PluginEvalTriggerSuite;
  evalCase: PluginEvalTriggerCase;
  subjectRoot: string;
  fixture: TriggerFixtureModule | null;
  codexBin: string;
  model?: string;
  codexRuntime: CodexEvalRuntimeConfig;
  timeoutMs: number;
  sourceEnv: NodeJS.ProcessEnv;
}): Promise<TriggerRunEvidence> {
  assertCodexEvalCanStartWork();
  const temporaryRoot = await createCodexEvalTemporaryRoot('aw-trigger-eval-');
  const runRoot = temporaryRoot.root;
  const workspaceRoot = path.join(runRoot, 'project');
  const codexHome = path.join(runRoot, 'codex-home');
  const startedAt = Date.now();
  const diagnostics: string[] = [];
  const eventTrace: unknown[] = [];
  let finalMessage: string | null = null;
  let usage: unknown = null;
  try {
    await assertProcessTreeInspectionAvailable();
    await fs.copy(options.subjectRoot, workspaceRoot, { dereference: false });
    const skillPath = path.join(
      workspaceRoot,
      '.agents',
      'skills',
      options.suite.skill,
      'SKILL.md',
    );
    if (!(await fs.pathExists(skillPath))) {
      throw new Error(`Materialized trigger skill is missing: ${skillPath}`);
    }
    const skillDigest = sha256(await fs.readFile(skillPath));
    let env = buildIsolatedEnv(
      options.sourceEnv,
      runRoot,
      codexHome,
      options.codexRuntime,
    );
    await Promise.all([
      fs.ensureDir(env.HOME!),
      fs.ensureDir(env.TMPDIR!),
      materializeCodexEvalRuntimeHome(options.codexRuntime, codexHome),
    ]);
    const initialContext: TriggerFixtureContext = {
      workspaceRoot,
      evalCase: options.evalCase,
      env,
    };
    const protectedEnvironment = protectedEnvironmentSnapshot(env);
    const fixtureResult = options.fixture
      ? await options.fixture.setupTriggerWorkspace(initialContext)
      : undefined;
    assertProtectedEnvironmentUnchanged(env, protectedEnvironment);
    env = mergeFixtureEnvironment(env, fixtureResult);
    const context: TriggerFixtureContext = {
      ...initialContext,
      env,
    };
    if (sha256(await fs.readFile(skillPath)) !== skillDigest) {
      throw new Error('Trigger fixture modified the materialized target skill.');
    }
    const beforeState = await captureState(options.fixture, context);
    const observed: TriggerObservation = {
      loaded: explicitSkillRequested(options.evalCase.query, options.suite.skill),
      spawned: false,
      loadEvidence: explicitSkillRequested(options.evalCase.query, options.suite.skill)
        ? `explicit $${options.suite.skill} invocation`
        : null,
      spawnEvidence: null,
    };
    const args = buildCodexArgs({
      suite: options.suite,
      evalCase: options.evalCase,
      workspaceRoot,
      model: options.model,
      modelProvider: options.codexRuntime.modelProvider,
      sensitiveEnvironmentNames: options.codexRuntime.sensitiveEnvironmentNames,
    });
    const executable = resolveCodexExecutable(options.codexBin);
    assertCodexEvalCanStartWork();
    const processResult = await new Promise<{
      termination: string;
      exitCode: number | null;
      signal: NodeJS.Signals | null;
      stderr: string;
      spawnCalls: Array<Record<string, unknown>>;
      interruptedSignal: NodeJS.Signals | null;
    }>((resolve, reject) => {
      const child = spawn(executable, args, {
        cwd: workspaceRoot,
        env,
        shell: false,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      let stopReason: string | null = null;
      let interruptedSignal: NodeJS.Signals | null = null;
      let settled = false;
      let rolloutPollPending = false;
      let spawnCalls: Array<Record<string, unknown>> = [];
      let unregisterSignalCleanup = (): void => undefined;
      let terminationPromise: Promise<string[]> | undefined;
      let recordedTerminationPromise: Promise<void> | undefined;
      const terminateTree = (): Promise<string[]> => {
        terminationPromise ??= terminateChildProcessTree(child);
        return terminationPromise;
      };
      const terminateTreeAndRecord = (): Promise<void> => {
        recordedTerminationPromise ??= terminateTree().then((terminationDiagnostics) => {
          diagnostics.push(...terminationDiagnostics);
        }, (error: unknown) => {
          diagnostics.push(
            `Trigger eval process-tree termination failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          throw error;
        });
        return recordedTerminationPromise;
      };
      const stop = (reason: string): void => {
        if (stopReason || child.exitCode !== null || child.signalCode !== null) {
          return;
        }
        stopReason = reason;
        void terminateTreeAndRecord().catch(() => undefined);
      };
      const childClosed = new Promise<void>((resolveClose) => {
        child.once('close', () => resolveClose());
      });
      unregisterSignalCleanup = registerCodexEvalSignalCleanup(async () => {
        stop('parent_signal_shutdown');
        await terminateTreeAndRecord();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const closed = await Promise.race([
          childClosed.then(() => true as const),
          new Promise<false>((resolveTimeout) => {
            timer = setTimeout(() => resolveTimeout(false), 3_000);
          }),
        ]);
        if (timer) clearTimeout(timer);
        if (!closed) {
          releaseChildProcessHandles(child);
          throw new Error('Could not confirm trigger eval process-tree termination within 3000ms.');
        }
      });
      const handleInterrupt = (signal: NodeJS.Signals): void => {
        interruptedSignal = signal;
        stop(`parent_${signal.toLowerCase()}`);
      };
      const handleSigint = (): void => handleInterrupt('SIGINT');
      const handleSigterm = (): void => handleInterrupt('SIGTERM');
      const removeInterruptHandlers = (): void => {
        process.off('SIGINT', handleSigint);
        process.off('SIGTERM', handleSigterm);
      };
      process.once('SIGINT', handleSigint);
      process.once('SIGTERM', handleSigterm);
      const timeout = setTimeout(() => stop('timeout'), options.timeoutMs);
      timeout.unref();
      const pollRollouts = async (): Promise<void> => {
        if (!options.suite.observeSpawnAgent || rolloutPollPending) {
          return;
        }
        rolloutPollPending = true;
        try {
          spawnCalls = await readTriggerSpawnCalls(codexHome);
          if (spawnCalls.length > 0) {
            observed.spawned = true;
            observed.spawnEvidence ??= `rollout:${String(spawnCalls[0].call_id ?? 'spawn_agent')}`;
            const reason = expectedEarlyStop(options.suite, options.evalCase, observed);
            if (reason) {
              stop(reason);
            }
          }
        } catch (error) {
          diagnostics.push(
            `Failed to read rollout evidence: ${error instanceof Error ? error.message : String(error)}`,
          );
        } finally {
          rolloutPollPending = false;
        }
      };
      const rolloutTimer = setInterval(() => void pollRollouts(), 250);
      rolloutTimer.unref();
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        stderr = `${stderr}${chunk}`.slice(-32_000);
      });
      const lines = readline.createInterface({ input: child.stdout });
      lines.on('line', (line) => {
        const event = parseTriggerExecEventLine(line);
        if (!event) {
          return;
        }
        eventTrace.push(event);
        const evidence = inspectTriggerExecEvent(event, skillPath);
        if (evidence.loaded) {
          observed.loaded = true;
          observed.loadEvidence ??= evidence.loadEvidence ?? null;
        }
        if (evidence.spawned) {
          observed.spawned = true;
          observed.spawnEvidence ??= evidence.spawnEvidence ?? null;
        }
        if (evidence.finalMessage !== undefined) {
          finalMessage = evidence.finalMessage;
        }
        if (evidence.usage !== undefined) {
          usage = evidence.usage;
        }
        const reason = expectedEarlyStop(options.suite, options.evalCase, observed);
        if (reason) {
          stop(reason);
        }
      });
      child.once('error', (error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        clearInterval(rolloutTimer);
        removeInterruptHandlers();
        unregisterSignalCleanup();
        lines.close();
        reject(new Error(`Failed to start ${executable}: ${error.message}`));
      });
      child.once('close', async (exitCode, signal) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        clearInterval(rolloutTimer);
        removeInterruptHandlers();
        lines.close();
        if (terminationPromise) {
          try {
            await terminateTreeAndRecord();
          } catch (error) {
            unregisterSignalCleanup();
            reject(error instanceof Error ? error : new Error(String(error)));
            return;
          }
        }
        unregisterSignalCleanup();
        if (options.suite.observeSpawnAgent) {
          try {
            spawnCalls = await readTriggerSpawnCalls(codexHome);
          } catch (error) {
            diagnostics.push(
              `Failed to read final rollout evidence: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        if (spawnCalls.length > 0) {
          observed.spawned = true;
          observed.spawnEvidence ??= `rollout:${String(spawnCalls[0].call_id ?? 'spawn_agent')}`;
        }
        resolve({
          termination: stopReason ?? 'completed',
          exitCode,
          signal,
          stderr: stderr.trim(),
          spawnCalls,
          interruptedSignal,
        });
      });
    });
    if (processResult.interruptedSignal) {
      throw new Error(`Interrupted by ${processResult.interruptedSignal}.`);
    }
    if (observed.spawned && processResult.spawnCalls.length === 0) {
      diagnostics.push('spawn_agent was observed without raw rollout argument evidence.');
    }
    const afterState = await captureState(options.fixture, context);
    const skillUnchanged =
      await fs.pathExists(skillPath) && sha256(await fs.readFile(skillPath)) === skillDigest;
    if (!skillUnchanged) {
      diagnostics.push('Materialized target skill changed during trigger evaluation.');
    }
    const fixtureUnchanged =
      stableJson(beforeState) === stableJson(afterState) && skillUnchanged;
    if (!fixtureUnchanged) {
      diagnostics.push('Trigger evaluation workspace state changed.');
    }
    const expectedStop = new Set([
      'expected_skill_load',
      'expected_outcome_observed',
      'unexpected_skill_load',
      'unexpected_spawn',
    ]).has(processResult.termination);
    const executionError =
      processResult.termination === 'timeout' ||
      (!expectedStop && processResult.exitCode !== 0) ||
      !fixtureUnchanged ||
      (observed.spawned && processResult.spawnCalls.length === 0) ||
      diagnostics.some((entry) => entry.startsWith('Failed to read'));
    return {
      loaded: observed.loaded,
      spawned: observed.spawned,
      load_evidence: observed.loadEvidence,
      spawn_evidence: observed.spawnEvidence,
      spawn_calls: processResult.spawnCalls,
      termination: processResult.termination,
      exit_code: processResult.exitCode,
      signal: processResult.signal,
      execution_error: executionError,
      fixture_unchanged: fixtureUnchanged,
      ...(processResult.stderr ? { stderr: processResult.stderr } : {}),
      final_message: finalMessage,
      duration_ms: Date.now() - startedAt,
      usage,
      event_trace: eventTrace,
      diagnostics,
    };
  } catch (error) {
    return {
      loaded: false,
      spawned: false,
      load_evidence: null,
      spawn_evidence: null,
      spawn_calls: [],
      termination: 'setup_error',
      exit_code: null,
      signal: null,
      execution_error: true,
      fixture_unchanged: false,
      final_message: finalMessage,
      duration_ms: Date.now() - startedAt,
      usage,
      event_trace: eventTrace,
      diagnostics: [error instanceof Error ? error.stack ?? error.message : String(error)],
    };
  } finally {
    await temporaryRoot.cleanup();
  }
}

function ratePasses(
  rate: number,
  expected: boolean,
  strictNegative: boolean,
): boolean {
  if (expected) {
    return rate > PASS_THRESHOLD;
  }
  return strictNegative ? rate === 0 : rate < PASS_THRESHOLD;
}

export function summarizeTriggerCase(
  suite: PluginEvalTriggerSuite,
  evalCase: PluginEvalTriggerCase,
  runs: TriggerRunEvidence[],
): TriggerCaseSummary {
  const loadRate = runs.filter((run) => run.loaded).length / runs.length;
  const spawnRate = runs.filter((run) => run.spawned).length / runs.length;
  const executionErrors = runs.filter((run) => run.execution_error).length;
  const strictNegative = suite.strictNegativeSplits.includes(evalCase.split);
  const loadPassed = ratePasses(loadRate, evalCase.should_load_skill, strictNegative);
  const spawnPassed = suite.observeSpawnAgent
    ? ratePasses(spawnRate, Boolean(evalCase.should_spawn_agent), strictNegative)
    : true;
  const complete = executionErrors === 0;
  return {
    id: evalCase.id,
    split: evalCase.split,
    query: evalCase.query,
    expected: {
      load_skill: evalCase.should_load_skill,
      ...(suite.observeSpawnAgent ? { spawn_agent: Boolean(evalCase.should_spawn_agent) } : {}),
    },
    observed: {
      load_rate: loadRate,
      ...(suite.observeSpawnAgent ? { spawn_rate: spawnRate } : {}),
      execution_errors: executionErrors,
    },
    complete,
    passed: complete && loadPassed && spawnPassed,
    runs,
  };
}

async function readCodexVersion(
  codexBin: string,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  try {
    const result = await execFileAsync(resolveCodexExecutable(codexBin), ['--version'], {
      env,
      timeout: 10_000,
      encoding: 'utf8',
    });
    return result.stdout.trim() || result.stderr.trim() || null;
  } catch {
    return null;
  }
}

export async function runCodexTriggerSuite(options: {
  suite: PluginEvalTriggerSuite;
  split: PluginEvalSplit;
  subjectRoot: string;
  pluginRoot: string;
  profile: string;
  runs: number;
  caseId?: string;
  codexBin: string;
  model?: string;
  codexRuntime?: CodexEvalRuntimeConfig;
  sourceEnv?: NodeJS.ProcessEnv;
  reportPath?: string;
  stderr?: (text: string) => void;
}): Promise<PluginEvalSuiteReport> {
  const sourceEnv = options.sourceEnv ?? process.env;
  const codexRuntime = options.codexRuntime ?? cleanCodexEvalRuntimeConfig(sourceEnv, options.model);
  const model = options.model ?? codexRuntime.model ?? undefined;
  const corpus = await readPluginEvalTriggerCases(options.pluginRoot, options.suite);
  let cases = options.split === 'all'
    ? corpus.cases
    : corpus.cases.filter((entry) => entry.split === options.split);
  if (options.caseId) {
    cases = cases.filter((entry) => entry.id === options.caseId);
  }
  if (cases.length === 0) {
    throw new Error(
      `Trigger suite "${options.suite.id}" has no matching cases for ${options.caseId ?? options.split}.`,
    );
  }
  let fixture: TriggerFixtureModule | null;
  try {
    if (options.suite.isolation === 'strict') {
      await assertStrictSystemConfigAbsent(sourceEnv);
    }
    fixture = await loadFixtureModule(options.pluginRoot, options.suite);
  } catch (error) {
    const diagnostic = error instanceof Error ? error.stack ?? error.message : String(error);
    const report = redactCodexEvalValue({
      schema_version: PLUGIN_EVAL_SCHEMA_VERSION,
      generated_at: new Date().toISOString(),
      suite: options.suite.id,
      profile: options.profile,
      split: options.split,
      complete: false,
      passed: false,
      environment_error: diagnostic,
      summary: { cases: cases.length, passed: 0, failed: 0 },
      results: [],
    }, codexRuntime);
    if (options.reportPath) {
      await fs.ensureDir(path.dirname(options.reportPath));
      await fs.writeJson(options.reportPath, report, { spaces: 2 });
    }
    return redactCodexEvalValue({
      id: options.suite.id,
      kind: 'trigger',
      profile: options.profile,
      split: options.split,
      outcome: 'incomplete',
      complete: false,
      mechanicalPassed: false,
      qualitativeReview: 'not_required',
      ...(options.reportPath ? { reportPath: options.reportPath } : {}),
      summary: report.summary,
      diagnostics: [diagnostic],
    }, codexRuntime);
  }
  const results: TriggerCaseSummary[] = [];
  for (const evalCase of cases) {
    const runs: TriggerRunEvidence[] = [];
    for (let runIndex = 0; runIndex < options.runs; runIndex += 1) {
      assertCodexEvalCanStartWork();
      options.stderr?.(
        `[${evalCase.split}] ${evalCase.id} run ${runIndex + 1}/${options.runs}\n`,
      );
      runs.push(await runTriggerOnce({
        suite: options.suite,
        evalCase,
        subjectRoot: options.subjectRoot,
        fixture,
        codexBin: options.codexBin,
        model,
        codexRuntime,
        timeoutMs: options.suite.perRunTimeoutMs,
        sourceEnv,
      }));
    }
    results.push(summarizeTriggerCase(options.suite, evalCase, runs));
  }
  const complete = results.every((result) => result.complete);
  const passed = complete && results.every((result) => result.passed);
  const skillPath = path.join(
    options.subjectRoot,
    '.agents',
    'skills',
    options.suite.skill,
    'SKILL.md',
  );
  const report = redactCodexEvalValue({
    schema_version: PLUGIN_EVAL_SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    suite: options.suite.id,
    profile: options.profile,
    split: options.split,
    runs_per_case: options.runs,
    threshold: PASS_THRESHOLD,
    model: model ?? null,
    complete,
    passed,
    environment: {
      codex_version: await readCodexVersion(options.codexBin, sourceEnv),
      isolation: {
        mode: options.suite.isolation,
        isolated_home: true,
        source_user_config_filtered: true,
        project_rules_ignored_by_default: true,
        bundled_surfaces_disabled: options.suite.isolation === 'strict',
        system_cloud_and_managed_layers_disabled: false,
      },
      codex_runtime: codexEvalRuntimeEvidence(codexRuntime),
      skill_sha256: sha256(await fs.readFile(skillPath)),
      corpus_sha256: sha256(stableJson(corpus)),
    },
    summary: {
      cases: results.length,
      passed: results.filter((result) => result.passed).length,
      failed: results.filter((result) => !result.passed).length,
    },
    results,
  }, codexRuntime);
  if (options.reportPath) {
    await fs.ensureDir(path.dirname(options.reportPath));
    await fs.writeJson(options.reportPath, report, { spaces: 2 });
  }
  return redactCodexEvalValue({
    id: options.suite.id,
    kind: 'trigger',
    profile: options.profile,
    split: options.split,
    outcome: !complete ? 'incomplete' : passed ? 'passed' : 'failed',
    complete,
    mechanicalPassed: passed,
    qualitativeReview: 'not_required',
    ...(options.reportPath ? { reportPath: options.reportPath } : {}),
    summary: report.summary,
    diagnostics: results.flatMap((result) =>
      result.runs.flatMap((run) => run.diagnostics)),
  }, codexRuntime);
}
