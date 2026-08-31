import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { computeSkillDigest } from './runtime-skill.js';
import fs from 'fs-extra';

import {
  CodexEvalAttemptControl,
  EvalAppServerSession,
  extractAppServerThreadId,
  inspectAppServerConfigWarning,
  type CodexEvalProcessManagementEvidence,
} from './codex-eval-app-server.js';

import {
  assertCodexEvalCanStartWork,
  applyCodexEvalProviderEnvironment,
  createCodexEvalTemporaryRoot,
  materializeCodexEvalRuntimeHome,
  type CodexEvalRuntimeConfig,
} from './codex-eval-runtime-config.js';
import {
  type AwSkillEvalTriggerCase,
  type AwSkillEvalTriggerSuiteCaseContract,
} from './codex-eval-cases.js';

async function createTriggerTemporaryRoot(
  workRoot?: string,
  strict = false,
): Promise<Awaited<ReturnType<typeof createCodexEvalTemporaryRoot>>> {
  if (strict || !workRoot) return createCodexEvalTemporaryRoot('aw-trigger-eval-');
  await fs.ensureDir(workRoot);
  return createCodexEvalTemporaryRoot('trigger-', {
    allocate: () => fs.mkdtemp(path.join(workRoot, 'trigger-')),
  });
}

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
  evalCase: AwSkillEvalTriggerCase;
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
  first_loaded_skill: string | null;
  all_loaded_skills: string[];
  load_evidence_by_skill: Record<string, string>;
  spawned: boolean;
  load_evidence: string | null;
  spawn_evidence: string | null;
  spawn_calls: Array<Record<string, unknown>>;
  termination: string;
  exit_code: number | null;
  signal: NodeJS.Signals | null;
  execution_error: boolean;
  fixture_unchanged: boolean;
  request_user_input_called: boolean;
  waiting_on_user_input: boolean;
  final_response_emitted: boolean;
  stderr?: string;
  final_message: string | null;
  duration_ms: number;
  usage: unknown;
  event_trace: unknown[];
  diagnostics: string[];
}

interface TriggerCaseSummary {
  id: string;
  split: AwSkillEvalTriggerCase['split'];
  query: string;
  expected: {
    load_skill?: boolean;
    loaded_skills?: string[];
    first_loaded_skill?: string;
    spawn_agent?: boolean;
  };
  observed: {
    load_rate: number;
    skill_load_rates: Record<string, number>;
    route_match_rate?: number;
    first_route_match_rate?: number;
    route_counts?: Record<string, number>;
    multiple_skill_loads: number;
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

function expectedLoadedSkills(
  suite: AwSkillEvalTriggerSuiteCaseContract,
  evalCase: AwSkillEvalTriggerCase,
): string[] {
  if (evalCase.expected_loaded_skills) {
    return [...evalCase.expected_loaded_skills];
  }
  return evalCase.should_load_skill ? [suite.skill] : [];
}

function sameSkillSet(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((entry) => right.includes(entry));
}

function routeLabel(skills: string[]): string {
  if (skills.length === 0) return 'neither';
  return [...skills].sort((left, right) => left.localeCompare(right)).join('+');
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

function commandOutputContainsSkill(
  item: Record<string, unknown>,
  skillPath: string,
): boolean {
  if (typeof item.aggregatedOutput !== 'string') return false;
  const skillName = path.basename(path.dirname(skillPath));
  const escaped = skillName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`^name:\\s*["']?${escaped}["']?\\s*$`, 'mu').test(
    item.aggregatedOutput,
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
  requestUserInput?: boolean;
} {
  const method = typeof frame.method === 'string' ? frame.method : '';
  const params = isRecord(frame.params) ? frame.params : {};
  const item = isRecord(params.item) ? params.item : null;
  if (item?.type === 'commandExecution' && typeof item.command === 'string') {
    const completed = method === 'item/completed';
    const statusPassed = item.status === undefined || item.status === 'completed';
    const exitPassed = item.exitCode === undefined || item.exitCode === 0;
    const outputProvesRead = commandOutputContainsSkill(item, skillPath);
    if (
      completed &&
      ((statusPassed && exitPassed) || outputProvesRead) &&
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
  if (
    method === 'item/completed' &&
    item?.type === 'agentMessage' &&
    item.phase !== 'commentary' &&
    typeof item.text === 'string'
  ) {
    return { finalMessage: item.text };
  }
  if (method === 'thread/tokenUsage/updated' && params.tokenUsage !== undefined) {
    return { usage: params.tokenUsage };
  }
  if (method === 'item/tool/requestUserInput') {
    return { requestUserInput: true };
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
  suite: AwSkillEvalTriggerSuiteCaseContract,
  evalCase: AwSkillEvalTriggerCase,
  observed: TriggerObservation,
  loadedSkills: string[],
): string | null {
  if (evalCase.expected_first_loaded_skill) {
    return loadedSkills[0] === evalCase.expected_first_loaded_skill
      ? 'expected_first_skill_route_observed'
      : null;
  }
  if (evalCase.expected_loaded_skills) {
    const expected = expectedLoadedSkills(suite, evalCase);
    if (suite.forbidMultipleSkillLoads && loadedSkills.length > 1) {
      return 'unexpected_multiple_skill_loads';
    }
    const routeResolved =
      expected.length === suite.skills.length && sameSkillSet(loadedSkills, expected);
    if (suite.observeSpawnAgent && !evalCase.should_spawn_agent && observed.spawned) {
      return 'unexpected_spawn';
    }
    if (
      routeResolved &&
      suite.observeSpawnAgent &&
      evalCase.should_spawn_agent &&
      observed.spawned
    ) {
      return 'expected_outcome_observed';
    }
    if (routeResolved && !suite.observeSpawnAgent) {
      return 'expected_skill_route_observed';
    }
    return null;
  }
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
  suite: AwSkillEvalTriggerSuiteCaseContract,
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
  skillNames: string[],
): Promise<void> {
  const skillsRoot = path.join(workspaceRoot, '.agents', 'skills');
  const allowed = new Set(skillNames);
  const entries = await fs.readdir(skillsRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  await Promise.all(entries.map(async (entry) => {
    if (allowed.has(entry)) return;
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
  suite: AwSkillEvalTriggerSuiteCaseContract;
  evalCase: AwSkillEvalTriggerCase;
  subjectRoot: string;
  fixture: TriggerFixtureModule | null;
  codexBin: string;
  model?: string;
  codexRuntime: CodexEvalRuntimeConfig;
  timeoutMs: number;
  sourceEnv: NodeJS.ProcessEnv;
  processManagement: CodexEvalProcessManagementEvidence;
  workRoot?: string;
  allowMissingSkills?: boolean;
  manageTimeout?: boolean;
  signal?: AbortSignal;
}): Promise<TriggerRunEvidence> {
  assertCodexEvalCanStartWork();
  const control = new CodexEvalAttemptControl({
    label: 'trigger evaluation',
    ...(options.manageTimeout === false ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const temporaryRoot = await createTriggerTemporaryRoot(
    options.workRoot,
    options.suite.isolation === 'strict',
  );
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
  let removeAbortHandler: (() => void) | undefined;
  try {
    await fs.copy(options.subjectRoot, workspaceRoot, { dereference: false });
    await isolateTriggerWorkspaceRules(
      workspaceRoot,
      options.evalCase.use_project_rules,
    );
    if (options.suite.isolation === 'strict') {
      await isolateTriggerWorkspaceSkills(workspaceRoot, options.suite.skills);
    }
    const declaredSkillPaths = new Map(options.suite.skills.map((skillName) => [
      skillName,
      path.join(workspaceRoot, '.agents', 'skills', skillName, 'SKILL.md'),
    ]));
    const skillPaths = new Map<string, string>();
    for (const [skillName, skillPath] of declaredSkillPaths) {
      if (await fs.pathExists(skillPath)) {
        skillPaths.set(skillName, skillPath);
      } else if (!options.allowMissingSkills) {
        throw new Error(`Materialized trigger Skill is missing: ${skillName} (${skillPath})`);
      }
    }
    const skillDigests = new Map(await Promise.all([...skillPaths].map(
      async ([skillName, skillPath]) => [
        skillName,
        await computeSkillDigest(path.dirname(skillPath)),
      ] as const,
    )));
    const ownerSkillPath = declaredSkillPaths.get(options.suite.skill)!;
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
    for (const [skillName, skillPath] of skillPaths) {
      if (await computeSkillDigest(path.dirname(skillPath)) !== skillDigests.get(skillName)) {
        throw new Error(`Trigger fixture modified materialized participant Skill "${skillName}".`);
      }
    }
    const beforeState = await captureState(options.fixture, context);
    const allLoadedSkills = options.suite.skills.filter((skillName) =>
      explicitSkillRequested(options.evalCase.query, skillName));
    const loadEvidenceBySkill = Object.fromEntries(allLoadedSkills.map((skillName) => [
      skillName,
      `explicit $${skillName} invocation`,
    ]));
    const observed: TriggerObservation = {
      loaded: allLoadedSkills.includes(options.suite.skill),
      spawned: false,
      loadEvidence: loadEvidenceBySkill[options.suite.skill] ?? null,
      spawnEvidence: null,
    };
    let requestUserInputCalled = false;
    let waitingOnUserInput = false;
    let finalResponseEmitted = false;
    const recordSkillLoad = (skillName: string, evidence: string | null | undefined): void => {
      if (!allLoadedSkills.includes(skillName)) allLoadedSkills.push(skillName);
      if (evidence && !loadEvidenceBySkill[skillName]) {
        loadEvidenceBySkill[skillName] = evidence;
      }
      if (skillName === options.suite.skill) {
        observed.loaded = true;
        observed.loadEvidence ??= evidence ?? null;
      }
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
    const abort = (): void => {
      finishRun(control.timeoutExpired ? 'timeout' : 'aborted');
      void session?.cleanup().catch((error: unknown) => {
        rejectRun(error instanceof Error ? error : new Error(String(error)));
      });
    };
    if (control.signal.aborted) abort();
    else {
      control.signal.addEventListener('abort', abort, { once: true });
      removeAbortHandler = () => control.signal.removeEventListener('abort', abort);
    }

    control.throwIfStopped('initialize');
    assertCodexEvalCanStartWork();
    session = new EvalAppServerSession({
      codexBin: resolveCodexExecutable(options.codexBin),
      cwd: workspaceRoot,
      env,
      modelProvider: options.codexRuntime.modelProvider,
      sensitiveEnvironmentNames: options.codexRuntime.sensitiveEnvironmentNames,
      isolation: options.suite.isolation,
      processManagement: options.processManagement,
      configOverrides: options.suite.observeSpawnAgent
        ? [
          'features.multi_agent=true',
          'features.multi_agent_v2.enabled=true',
          'features.multi_agent_v2.hide_spawn_agent_metadata=true',
          'features.multi_agent_v2.expose_spawn_agent_model_overrides=true',
        ]
        : [],
    });
    control.throwIfStopped('initialize');
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
      const evidence = inspectTriggerAppServerFrame(frame, ownerSkillPath);
      for (const [skillName, skillPath] of skillPaths) {
        const skillEvidence = inspectTriggerAppServerFrame(frame, skillPath);
        if (skillEvidence.loaded) {
          recordSkillLoad(skillName, skillEvidence.loadEvidence);
        }
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
        finalResponseEmitted = true;
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
      if (evidence.requestUserInput) {
        requestUserInputCalled = true;
        waitingOnUserInput = true;
        finishRun('waiting_on_user_input');
        return;
      }
      const reason = expectedEarlyStop(
        options.suite,
        options.evalCase,
        observed,
        allLoadedSkills,
      );
      if (reason) finishRun(reason);
    });
    await session.initialize(control.rpcTimeout('initialize'));
    control.throwIfStopped('initialize');
    const threadResult = await session.sendRequest('thread/start', {
      cwd: workspaceRoot,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      ephemeral: false,
      ...(options.model ? { model: options.model } : {}),
    }, control.rpcTimeout('thread/start'));
    rootThreadId = extractAppServerThreadId(threadResult);
    control.throwIfStopped('turn/start');
    await session.sendRequest('turn/start', {
      threadId: rootThreadId,
      input: [{ type: 'text', text: options.evalCase.query, text_elements: [] }],
      cwd: workspaceRoot,
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'readOnly', networkAccess: true },
      ...(options.model ? { model: options.model } : {}),
    }, control.rpcTimeout('turn/start'));
    const termination = await runDone;
    control.throwIfStopped('turn wait');
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
    if (!cleanupFailed) control.throwIfStopped('cleanup');
    const afterState = await captureState(options.fixture, context);
    let skillsUnchanged = true;
    for (const [skillName, skillPath] of skillPaths) {
      const unchanged = await fs.pathExists(skillPath) &&
        await computeSkillDigest(path.dirname(skillPath)) === skillDigests.get(skillName);
      if (!unchanged) {
        skillsUnchanged = false;
        diagnostics.push(`Materialized participant Skill "${skillName}" changed during trigger evaluation.`);
      }
    }
    const fixtureUnchanged =
      stableJson(beforeState) === stableJson(afterState) && skillsUnchanged;
    if (!fixtureUnchanged) {
      diagnostics.push('Trigger evaluation workspace state changed.');
    }
    const expectedStop = new Set([
      'expected_skill_load',
      'expected_outcome_observed',
      'unexpected_skill_load',
      'unexpected_spawn',
      'unexpected_multiple_skill_loads',
      'expected_skill_route_observed',
      'waiting_on_user_input',
    ]).has(termination);
    const executionError =
      termination === 'timeout' ||
      termination === 'aborted' ||
      termination === 'strict_isolation_error' ||
      termination === 'app_server_error' ||
      (!expectedStop && termination === 'completed' && turnStatus !== 'completed') ||
      !fixtureUnchanged ||
      cleanupFailed;
    return session.scrub({
      loaded: observed.loaded,
      first_loaded_skill: allLoadedSkills[0] ?? null,
      all_loaded_skills: allLoadedSkills,
      load_evidence_by_skill: loadEvidenceBySkill,
      spawned: observed.spawned,
      load_evidence: observed.loadEvidence,
      spawn_evidence: observed.spawnEvidence,
      spawn_calls: spawnCalls,
      termination,
      exit_code: null,
      signal: null,
      execution_error: executionError,
      fixture_unchanged: fixtureUnchanged,
      request_user_input_called: requestUserInputCalled,
      waiting_on_user_input: waitingOnUserInput,
      final_response_emitted: finalResponseEmitted,
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
      first_loaded_skill: null,
      all_loaded_skills: [],
      load_evidence_by_skill: {},
      spawned: false,
      load_evidence: null,
      spawn_evidence: null,
      spawn_calls: [],
      termination: control.timeoutExpired ? 'timeout' : 'setup_error',
      exit_code: null,
      signal: null,
      execution_error: true,
      fixture_unchanged: false,
      request_user_input_called: false,
      waiting_on_user_input: false,
      final_response_emitted: finalMessage !== null,
      final_message: finalMessage,
      duration_ms: Date.now() - startedAt,
      usage,
      event_trace: eventTrace,
      diagnostics: [error instanceof Error ? error.stack ?? error.message : String(error)],
    };
    return session ? session.scrub(evidence) : evidence;
  } finally {
    removeHandler?.();
    removeFailureHandler?.();
    removeAbortHandler?.();
    try {
      await session?.cleanup();
    } catch (error) {
      throw new Error(
        `Trigger eval app-server cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      try {
        await temporaryRoot.cleanup();
      } finally {
        control.dispose();
      }
    }
  }
}

export async function runCodexTriggerProviderCase(options: {
  suite: AwSkillEvalTriggerSuiteCaseContract;
  evalCase: AwSkillEvalTriggerCase;
  subjectRoot: string;
  fixtureRoot: string;
  codexBin: string;
  model?: string;
  codexRuntime: CodexEvalRuntimeConfig;
  sourceEnv?: NodeJS.ProcessEnv;
  processManagement?: CodexEvalProcessManagementEvidence;
  workRoot?: string;
  manageTimeout?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<TriggerRunEvidence> {
  const fixture = await loadFixtureModule(options.fixtureRoot, options.suite);
  return runTriggerOnce({
    suite: options.suite,
    evalCase: options.evalCase,
    subjectRoot: options.subjectRoot,
    fixture,
    codexBin: options.codexBin,
    ...(options.model ? { model: options.model } : {}),
    codexRuntime: options.codexRuntime,
    timeoutMs: options.timeoutMs ?? options.suite.perRunTimeoutMs,
    sourceEnv: options.sourceEnv ?? process.env,
    processManagement: options.processManagement ?? {
      mode: 'unmanaged-confirmed',
      inspectionAvailable: false,
      userAcknowledged: true,
      descendantCleanupGuaranteed: false,
      limitation: 'The AwSkillEval engine owns the provider process tree and timeout.',
    },
    allowMissingSkills: true,
    manageTimeout: options.manageTimeout ?? false,
    ...(options.workRoot ? { workRoot: options.workRoot } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
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
  suite: AwSkillEvalTriggerSuiteCaseContract,
  evalCase: AwSkillEvalTriggerCase,
  runs: TriggerRunEvidence[],
): TriggerCaseSummary {
  const loadRate = runs.filter((run) => run.loaded).length / runs.length;
  const skillLoadRates = Object.fromEntries(suite.skills.map((skillName) => [
    skillName,
    runs.filter((run) => run.all_loaded_skills.includes(skillName)).length / runs.length,
  ]));
  const spawnRate = runs.filter((run) => run.spawned).length / runs.length;
  const executionErrors = runs.filter((run) => run.execution_error).length;
  const strictNegative = suite.strictNegativeSplits.includes(evalCase.split);
  const usesRouteExpectation = evalCase.expected_loaded_skills !== undefined;
  const usesFirstRouteExpectation = evalCase.expected_first_loaded_skill !== undefined;
  const expectedSkills = expectedLoadedSkills(suite, evalCase);
  const routeMatches = runs.filter((run) =>
    sameSkillSet(run.all_loaded_skills, expectedSkills)).length;
  const routeMatchRate = routeMatches / runs.length;
  const firstRouteMatches = usesFirstRouteExpectation
    ? runs.filter((run) =>
      run.first_loaded_skill === evalCase.expected_first_loaded_skill).length
    : 0;
  const firstRouteMatchRate = firstRouteMatches / runs.length;
  const multipleSkillLoads = runs.filter((run) => run.all_loaded_skills.length > 1).length;
  const loadPassed = usesFirstRouteExpectation
    ? firstRouteMatchRate >= (suite.minimumPassRate ?? PASS_THRESHOLD)
    : usesRouteExpectation
    ? strictNegative && expectedSkills.length === 0
      ? routeMatchRate === 1
      : routeMatchRate >= (suite.minimumPassRate ?? PASS_THRESHOLD)
    : ratePasses(loadRate, Boolean(evalCase.should_load_skill), strictNegative);
  const routePassed = usesFirstRouteExpectation
    || !suite.forbidMultipleSkillLoads
    || multipleSkillLoads === 0;
  const spawnPassed = suite.observeSpawnAgent
    ? ratePasses(spawnRate, Boolean(evalCase.should_spawn_agent), strictNegative)
    : true;
  const complete = executionErrors === 0;
  const routeCounts = Object.fromEntries([...new Set(runs.map((run) =>
    routeLabel(run.all_loaded_skills)))].map((route) => [
    route,
    runs.filter((run) => routeLabel(run.all_loaded_skills) === route).length,
  ]));
  return {
    id: evalCase.id,
    split: evalCase.split,
    query: evalCase.query,
    expected: {
      ...(usesFirstRouteExpectation
        ? { first_loaded_skill: evalCase.expected_first_loaded_skill }
        : usesRouteExpectation
        ? { loaded_skills: expectedSkills }
        : { load_skill: Boolean(evalCase.should_load_skill) }),
      ...(suite.observeSpawnAgent ? { spawn_agent: Boolean(evalCase.should_spawn_agent) } : {}),
    },
    observed: {
      load_rate: loadRate,
      skill_load_rates: skillLoadRates,
      ...(usesRouteExpectation ? {
        route_match_rate: routeMatchRate,
        route_counts: routeCounts,
      } : {}),
      ...(usesFirstRouteExpectation ? {
        first_route_match_rate: firstRouteMatchRate,
      } : {}),
      multiple_skill_loads: multipleSkillLoads,
      ...(suite.observeSpawnAgent ? { spawn_rate: spawnRate } : {}),
      execution_errors: executionErrors,
    },
    complete,
    passed: complete && loadPassed && routePassed && spawnPassed,
    runs,
  };
}
