import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

import fs from 'fs-extra';

import {
  EvalAppServerSession,
  extractAppServerThreadId,
  inspectAppServerConfigWarning,
  runCodexEvalIsolationProbe,
} from './codex-eval-app-server.js';
import {
  codexEvalIsolationEvidence,
  inspectCodexEvalHostIsolation,
  type CodexEvalHostIsolationEvidence,
  type CodexEvalRpcIsolationEvidence,
} from './codex-eval-isolation.js';

import {
  assertCodexEvalCanStartWork,
  applyCodexEvalProviderEnvironment,
  cleanCodexEvalRuntimeConfig,
  codexEvalRuntimeEvidence,
  createCodexEvalTemporaryRoot,
  materializeCodexEvalRuntimeHome,
  redactCodexEvalValue,
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

export function inspectTriggerAppServerFrame(
  frame: Record<string, unknown>,
  skillPath: string,
): Partial<TriggerObservation> & {
  finalMessage?: string;
  usage?: unknown;
  turnStatus?: string;
  spawnCall?: Record<string, unknown>;
} {
  const method = typeof frame.method === 'string' ? frame.method : '';
  const params = isRecord(frame.params) ? frame.params : {};
  const item = isRecord(params.item) ? params.item : null;
  if (item?.type === 'commandExecution' && typeof item.command === 'string') {
    const completed = method === 'item/completed';
    const statusPassed = item.status === undefined || item.status === 'completed';
    const exitPassed = item.exitCode === undefined || item.exitCode === 0;
    if (
      completed &&
      statusPassed &&
      exitPassed &&
      normalizedCommandReadsSkill(item.command, skillPath)
    ) {
      return { loaded: true, loadEvidence: item.command };
    }
  }
  if (
    (method === 'item/started' || method === 'item/completed') &&
    item?.type === 'subAgentActivity' &&
    item.kind === 'started'
  ) {
    const agentPath = typeof item.agentPath === 'string' ? item.agentPath : null;
    const agentThreadId = typeof item.agentThreadId === 'string' ? item.agentThreadId : null;
    return {
      spawned: true,
      spawnEvidence: `app-server:${agentPath ?? agentThreadId ?? String(item.id ?? 'started')}`,
      spawnCall: {
        source: 'app_server_sub_agent_activity',
        event_id: typeof item.id === 'string' ? item.id : null,
        kind: 'started',
        agent_thread_id: agentThreadId,
        agent_path: agentPath,
      },
    };
  }
  if (method === 'item/completed' && item?.type === 'agentMessage' && typeof item.text === 'string') {
    return { finalMessage: item.text };
  }
  if (method === 'thread/tokenUsage/updated' && params.tokenUsage !== undefined) {
    return { usage: params.tokenUsage };
  }
  if (method === 'turn/completed') {
    const turn = isRecord(params.turn) ? params.turn : {};
    return { turnStatus: typeof turn.status === 'string' ? turn.status : 'unknown' };
  }
  return {};
}

export function inspectTriggerAppServerConfigWarning(
  frame: Record<string, unknown>,
): string | null {
  return inspectAppServerConfigWarning(frame);
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

async function isolateTriggerWorkspaceSkills(
  workspaceRoot: string,
  skillName: string,
): Promise<void> {
  const skillsRoot = path.join(workspaceRoot, '.agents', 'skills');
  const entries = await fs.readdir(skillsRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  await Promise.all(entries.map(async (entry) => {
    if (entry === skillName) return;
    await fs.remove(path.join(skillsRoot, entry));
  }));
}

async function isolateTriggerWorkspaceRules(
  workspaceRoot: string,
  useProjectRules: boolean | undefined,
): Promise<void> {
  if (useProjectRules === true) return;
  await fs.remove(path.join(workspaceRoot, '.codex', 'rules'));
}

async function snapshotStrictControlPlane(
  workspaceRoot: string,
): Promise<Record<string, string>> {
  const snapshot = await snapshotWorkspace(workspaceRoot);
  return Object.fromEntries(Object.entries(snapshot).filter(([entry]) =>
    entry === '.agents' ||
    entry.startsWith('.agents/') ||
    entry === '.codex' ||
    entry.startsWith('.codex/')
  ));
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
  let session: EvalAppServerSession | undefined;
  let removeHandler: (() => void) | undefined;
  let removeFailureHandler: (() => void) | undefined;
  let turnTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await fs.copy(options.subjectRoot, workspaceRoot, { dereference: false });
    await isolateTriggerWorkspaceRules(
      workspaceRoot,
      options.evalCase.use_project_rules,
    );
    if (options.suite.isolation === 'strict') {
      await isolateTriggerWorkspaceSkills(workspaceRoot, options.suite.skill);
    }
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
      materializeCodexEvalRuntimeHome(options.codexRuntime, codexHome, {
        trustedProject: workspaceRoot,
      }),
    ]);
    const initialContext: TriggerFixtureContext = {
      workspaceRoot,
      evalCase: options.evalCase,
      env,
    };
    const protectedEnvironment = protectedEnvironmentSnapshot(env);
    const controlPlaneBefore = options.suite.isolation === 'strict'
      ? await snapshotStrictControlPlane(workspaceRoot)
      : null;
    const fixtureResult = options.fixture
      ? await options.fixture.setupTriggerWorkspace(initialContext)
      : undefined;
    assertProtectedEnvironmentUnchanged(env, protectedEnvironment);
    env = mergeFixtureEnvironment(env, fixtureResult);
    if (
      controlPlaneBefore &&
      stableJson(controlPlaneBefore) !== stableJson(await snapshotStrictControlPlane(workspaceRoot))
    ) {
      throw new Error('Trigger fixture modified strict eval control-plane files.');
    }
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
    const spawnCalls: Array<Record<string, unknown>> = [];
    const spawnCallIds = new Set<string>();
    let rootThreadId: string | undefined;
    let turnStatus: string | undefined;
    let finishRun: (termination: string) => void = () => undefined;
    let rejectRun: (error: Error) => void = () => undefined;
    let runSettled = false;
    const runDone = new Promise<string>((resolve, reject) => {
      finishRun = (termination) => {
        if (runSettled) return;
        runSettled = true;
        resolve(termination);
      };
      rejectRun = (error) => {
        if (runSettled) return;
        runSettled = true;
        reject(error);
      };
    });
    void runDone.catch(() => undefined);

    assertCodexEvalCanStartWork();
    session = new EvalAppServerSession({
      codexBin: resolveCodexExecutable(options.codexBin),
      cwd: workspaceRoot,
      env,
      modelProvider: options.codexRuntime.modelProvider,
      sensitiveEnvironmentNames: options.codexRuntime.sensitiveEnvironmentNames,
      isolation: options.suite.isolation,
      configOverrides: options.suite.observeSpawnAgent
        ? [
          'features.multi_agent=true',
          'features.multi_agent_v2.enabled=true',
          'features.multi_agent_v2.hide_spawn_agent_metadata=true',
          'features.multi_agent_v2.expose_spawn_agent_model_overrides=true',
        ]
        : [],
    });
    removeFailureHandler = session.onFailure(rejectRun);
    removeHandler = session.onFrame((frame) => {
      const method = typeof frame.method === 'string' ? frame.method : '';
      const params = isRecord(frame.params) ? frame.params : {};
      if (!method.startsWith('remoteControl/') && !method.startsWith('account/')) {
        eventTrace.push(frame);
      }
      const configWarning = options.suite.isolation === 'strict'
        ? inspectTriggerAppServerConfigWarning(frame)
        : null;
      if (configWarning) {
        diagnostics.push(`Strict Codex eval received a config warning: ${configWarning}`);
        finishRun('strict_isolation_error');
        return;
      }
      const frameThreadId = typeof params.threadId === 'string' ? params.threadId : undefined;
      if (rootThreadId && frameThreadId && frameThreadId !== rootThreadId) {
        return;
      }
      const evidence = inspectTriggerAppServerFrame(frame, skillPath);
      if (evidence.loaded) {
        observed.loaded = true;
        observed.loadEvidence ??= evidence.loadEvidence ?? null;
      }
      if (evidence.spawned) {
        observed.spawned = true;
        observed.spawnEvidence ??= evidence.spawnEvidence ?? null;
      }
      if (evidence.spawnCall) {
        const identity = `${String(evidence.spawnCall.event_id)}:${String(
          evidence.spawnCall.agent_thread_id,
        )}`;
        if (!spawnCallIds.has(identity)) {
          spawnCallIds.add(identity);
          spawnCalls.push(evidence.spawnCall);
        }
      }
      if (evidence.finalMessage !== undefined) {
        finalMessage = evidence.finalMessage;
      }
      if (evidence.usage !== undefined) {
        usage = evidence.usage;
      }
      if (evidence.turnStatus !== undefined) {
        turnStatus = evidence.turnStatus;
        finishRun('completed');
        return;
      }
      if (method === 'error') {
        diagnostics.push(`app-server error: ${JSON.stringify(params)}`);
        finishRun('app_server_error');
        return;
      }
      const reason = expectedEarlyStop(options.suite, options.evalCase, observed);
      if (reason) finishRun(reason);
    });
    turnTimer = setTimeout(() => finishRun('timeout'), options.timeoutMs);
    turnTimer.unref();
    await session.initialize();
    const threadResult = await session.sendRequest('thread/start', {
      cwd: workspaceRoot,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      ephemeral: false,
      ...(options.model ? { model: options.model } : {}),
    });
    rootThreadId = extractAppServerThreadId(threadResult);
    await session.sendRequest('turn/start', {
      threadId: rootThreadId,
      input: [{ type: 'text', text: options.evalCase.query, text_elements: [] }],
      cwd: workspaceRoot,
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'readOnly', networkAccess: true },
      ...(options.model ? { model: options.model } : {}),
    });
    const termination = await runDone;
    if (turnTimer) {
      clearTimeout(turnTimer);
      turnTimer = undefined;
    }
    removeHandler();
    removeHandler = undefined;
    removeFailureHandler();
    removeFailureHandler = undefined;
    let cleanupFailed = false;
    try {
      await session.cleanup();
    } catch (error) {
      cleanupFailed = true;
      diagnostics.push(
        `Trigger eval app-server cleanup failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
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
    ]).has(termination);
    const executionError =
      termination === 'timeout' ||
      termination === 'strict_isolation_error' ||
      termination === 'app_server_error' ||
      (!expectedStop && termination === 'completed' && turnStatus !== 'completed') ||
      !fixtureUnchanged ||
      cleanupFailed;
    return session.scrub({
      loaded: observed.loaded,
      spawned: observed.spawned,
      load_evidence: observed.loadEvidence,
      spawn_evidence: observed.spawnEvidence,
      spawn_calls: spawnCalls,
      termination,
      exit_code: null,
      signal: null,
      execution_error: executionError,
      fixture_unchanged: fixtureUnchanged,
      ...(session.stderr.trim() ? { stderr: session.stderr.trim() } : {}),
      final_message: finalMessage,
      duration_ms: Date.now() - startedAt,
      usage,
      event_trace: eventTrace,
      diagnostics,
    });
  } catch (error) {
    const evidence: TriggerRunEvidence = {
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
    return session ? session.scrub(evidence) : evidence;
  } finally {
    if (turnTimer) clearTimeout(turnTimer);
    removeHandler?.();
    removeFailureHandler?.();
    try {
      await session?.cleanup();
    } catch {
      // The primary result already records cleanup failures when the session started.
    } finally {
      await temporaryRoot.cleanup();
    }
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
  let hostIsolation: CodexEvalHostIsolationEvidence | null = null;
  let runtimeProbe: CodexEvalRpcIsolationEvidence | null = null;
  try {
    if (options.suite.isolation === 'strict') {
      hostIsolation = await inspectCodexEvalHostIsolation({ sourceEnv });
      runtimeProbe = await runCodexEvalIsolationProbe({
        subjectRoot: options.subjectRoot,
        skillName: options.suite.skill,
        codexBin: options.codexBin,
        codexRuntime,
        sourceEnv,
      });
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
      environment: {
        isolation: codexEvalIsolationEvidence({
          mode: options.suite.isolation,
          host: hostIsolation,
          runtimeProbe,
        }),
        codex_runtime: codexEvalRuntimeEvidence(codexRuntime),
      },
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
        ...codexEvalIsolationEvidence({
          mode: options.suite.isolation,
          host: hostIsolation,
          runtimeProbe,
        }),
        app_server_protocol: true,
        project_rules_ignored_by_default: true,
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
