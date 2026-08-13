import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';

import fs from 'fs-extra';

import {
  assertProcessTreeInspectionAvailable,
  CODEX_EVAL_PROCESS_TREE_ID_ENV,
  createChildProcessTreeMonitor,
  createDirectChildProcessMonitor,
  type ChildProcessTreeMonitor,
  processTreeCleanupIsUnconfirmed,
  releaseChildProcessHandles,
  scrubProcessTreeId,
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
  codexEvalConfigOverrides,
  codexEvalIsolationEvidence,
  inspectCodexEvalHostIsolation,
  validateCodexEvalConfigIsolation,
  validateCodexEvalRpcIsolation,
  type CodexEvalHostIsolationEvidence,
  type CodexEvalRpcIsolationEvidence,
} from './codex-eval-isolation.js';
import {
  validatePluginEvalConversationCaseDocument,
  type PluginEvalCaseCheckpoint,
  type PluginEvalIsolation,
  type PluginEvalProcessManagementEvidence,
  type PluginEvalSuiteReport,
} from './plugin-eval-contract.js';

const DEFAULT_MANAGED_PROCESS_EVIDENCE: PluginEvalProcessManagementEvidence = {
  mode: 'managed',
  inspectionAvailable: true,
  userAcknowledged: false,
  descendantCleanupGuaranteed: true,
};

async function createEvalTemporaryRoot(
  prefix: string,
  workRoot?: string,
): Promise<Awaited<ReturnType<typeof createCodexEvalTemporaryRoot>>> {
  if (!workRoot) return createCodexEvalTemporaryRoot(prefix);
  await fs.ensureDir(workRoot);
  return createCodexEvalTemporaryRoot(prefix, {
    allocate: () => fs.mkdtemp(path.join(workRoot, prefix)),
  });
}

interface AppServerProcess {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  unref(): void;
  once(event: 'error', listener: (error: Error) => void): this;
  once(
    event: 'close',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
}

interface ScriptedReply {
  expectedQuestionCount?: number;
  answersByIndex: string[];
  unexpectedQuestionAnswer: string;
}

interface WorkspaceArtifactExpectation {
  path: string;
  exists: boolean;
  contains: string[];
  notContains: string[];
  json?: Record<string, unknown>;
}

interface WorkspaceArtifactEvidence {
  path: string;
  exists: boolean;
  kind: 'absent' | 'file' | 'other';
  bytes?: number;
  sha256?: string;
  text?: string;
}

interface ConversationEvalCase {
  id: string;
  prompt: string;
  scriptedReplies: ScriptedReply[];
  expectedOutput: string;
  checks: string[];
  workspaceUnchanged: boolean;
  sandbox: 'read-only' | 'workspace-write';
  allowedWorkspaceChanges: string[];
  artifacts: WorkspaceArtifactExpectation[];
}

interface AppServerRunEvidence {
  variant: 'with_skill' | 'without_skill';
  complete: boolean;
  mechanicalPassed: boolean;
  hostSourceAccessAbsent: boolean | null;
  durationMs: number;
  questions: Array<{
    requestId: string;
    step: number;
    questions: Array<{
      id: string;
      header: string;
      question: string;
      options: Array<{ label: string; description: string }> | null;
    }>;
    answers: Record<string, string[]>;
  }>;
  finalMessages: string[];
  usage: unknown;
  workspaceChanges: string[];
  workspaceArtifacts: WorkspaceArtifactEvidence[];
  diagnostics: string[];
  eventTrace: unknown[];
  isolation: CodexEvalRpcIsolationEvidence | null;
  stderr?: string;
}

interface ConversationCaseResult {
  id: string;
  prompt: string;
  expected_output: string;
  checks: string[];
  runs: Array<{
    run: number;
    with_skill: AppServerRunEvidence;
    without_skill: AppServerRunEvidence;
  }>;
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await fs.ensureDir(path.dirname(filePath));
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeJson(temporary, value, { spaces: 2 });
  await fs.rename(temporary, filePath);
}

interface PendingRequest {
  method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

interface AppServerFrameHandler {
  (frame: Record<string, unknown>): Promise<void> | void;
}

export async function settleAppServerProcessCleanup(options: {
  child: ChildProcess;
  processTreeMonitor: ChildProcessTreeMonitor;
  waitForClose: (timeoutMs: number) => Promise<boolean>;
}): Promise<void> {
  const diagnostics = await options.processTreeMonitor.terminate();
  const cleanupUnconfirmed = processTreeCleanupIsUnconfirmed(diagnostics);
  const closed = await options.waitForClose(1_000);
  if (!closed) releaseChildProcessHandles(options.child);
  if (cleanupUnconfirmed) throw new Error(diagnostics.join(' '));
  if (closed) return;
  throw new Error(
    `Could not confirm Codex app-server process-tree termination. ${diagnostics.join(' ')}`.trim(),
  );
}

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
const CODEX_EVAL_APP_SERVER_OVERRIDES = [
  'features.default_mode_request_user_input=true',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function comparablePath(value: string): string {
  const normalized = value.replaceAll('\\', '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function containsForbiddenHostRoot(value: unknown, forbiddenHostRoots: string[]): boolean {
  if (typeof value === 'string') {
    const candidate = comparablePath(value);
    return forbiddenHostRoots.some((root) => candidate.includes(comparablePath(root)));
  }
  if (Array.isArray(value)) {
    return value.some((entry) => containsForbiddenHostRoot(entry, forbiddenHostRoots));
  }
  if (isRecord(value)) {
    return Object.values(value).some((entry) =>
      containsForbiddenHostRoot(entry, forbiddenHostRoots));
  }
  return false;
}

async function canonicalForbiddenHostRoots(roots: string[]): Promise<string[]> {
  const values = await Promise.all(roots.map(async (root) => {
    const resolved = path.resolve(root);
    const real = await fs.realpath(resolved).catch(() => resolved);
    return [resolved, real];
  }));
  return [...new Set(values.flat())];
}

function requestId(value: unknown): string | undefined {
  const rawId = appServerRequestId(value);
  return rawId === undefined ? undefined : String(rawId);
}

function appServerRequestId(value: unknown): string | number | undefined {
  return typeof value === 'string' || typeof value === 'number'
    ? value
    : undefined;
}

export function inspectAppServerConfigWarning(
  frame: Record<string, unknown>,
): string | null {
  if (frame.method !== 'configWarning') return null;
  const params = isRecord(frame.params) ? frame.params : {};
  return typeof params.summary === 'string' ? params.summary : JSON.stringify(params);
}

function buildIsolatedEnv(
  sourceEnv: NodeJS.ProcessEnv,
  root: string,
  codexHome: string,
  runtime: CodexEvalRuntimeConfig,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of PASSTHROUGH_ENV) {
    if (sourceEnv[name] !== undefined) {
      env[name] = sourceEnv[name];
    }
  }
  const home = path.join(root, 'home');
  const temp = path.join(root, 'tmp');
  return applyCodexEvalProviderEnvironment({
    ...env,
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: codexHome,
    XDG_CACHE_HOME: path.join(root, 'xdg-cache'),
    XDG_CONFIG_HOME: path.join(root, 'xdg-config'),
    XDG_STATE_HOME: path.join(root, 'xdg-state'),
    TMPDIR: temp,
    TEMP: temp,
    TMP: temp,
    NO_COLOR: '1',
  }, runtime);
}

async function snapshotWorkspace(root: string): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>();
  async function visit(current: string): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const absolutePath = path.join(current, entry.name);
      const relativePath = path.relative(root, absolutePath).split(path.sep).join('/');
      if (entry.isDirectory()) {
        snapshot.set(`${relativePath}/`, 'directory');
        await visit(absolutePath);
      } else if (entry.isFile()) {
        snapshot.set(
          relativePath,
          createHash('sha256').update(await fs.readFile(absolutePath)).digest('hex'),
        );
      } else if (entry.isSymbolicLink()) {
        snapshot.set(relativePath, `symlink:${await fs.readlink(absolutePath)}`);
      } else {
        snapshot.set(relativePath, 'other');
      }
    }
  }
  await visit(root);
  return snapshot;
}

function workspacePathMatchesPattern(relativePath: string, pattern: string): boolean {
  if (pattern.endsWith('/**')) {
    const prefix = pattern.slice(0, -3);
    return relativePath === prefix || relativePath.startsWith(`${prefix}/`);
  }
  return relativePath === pattern;
}

function jsonContains(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) {
    return Array.isArray(actual)
      && actual.length === expected.length
      && expected.every((entry, index) => jsonContains(actual[index], entry));
  }
  if (isRecord(expected)) {
    return isRecord(actual)
      && Object.entries(expected).every(([key, value]) =>
        Object.prototype.hasOwnProperty.call(actual, key) && jsonContains(actual[key], value));
  }
  return Object.is(actual, expected);
}

async function readWorkspaceArtifactEvidence(
  workspaceRoot: string,
  expectation: WorkspaceArtifactExpectation,
): Promise<WorkspaceArtifactEvidence> {
  const absolutePath = path.join(workspaceRoot, ...expectation.path.split('/'));
  const stat = await fs.lstat(absolutePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!stat) {
    return { path: expectation.path, exists: false, kind: 'absent' };
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    return { path: expectation.path, exists: true, kind: 'other' };
  }
  const content = await fs.readFile(absolutePath);
  const evidence: WorkspaceArtifactEvidence = {
    path: expectation.path,
    exists: true,
    kind: 'file',
    bytes: content.length,
    sha256: createHash('sha256').update(content).digest('hex'),
  };
  if (content.length <= 64 * 1024 && !content.includes(0)) {
    evidence.text = content.toString('utf8');
  }
  return evidence;
}

function validateWorkspaceArtifact(
  expectation: WorkspaceArtifactExpectation,
  evidence: WorkspaceArtifactEvidence,
): string[] {
  const diagnostics: string[] = [];
  if (evidence.exists !== expectation.exists) {
    diagnostics.push(
      `Artifact ${expectation.path} expected exists=${expectation.exists} but exists=${evidence.exists}.`,
    );
    return diagnostics;
  }
  if (!expectation.exists) return diagnostics;
  if (evidence.kind !== 'file') {
    diagnostics.push(`Artifact ${expectation.path} must be a regular file.`);
    return diagnostics;
  }
  const text = evidence.text;
  if ((expectation.contains.length > 0 || expectation.notContains.length > 0 || expectation.json) && text === undefined) {
    diagnostics.push(`Artifact ${expectation.path} is binary or exceeds the 64 KiB assertion limit.`);
    return diagnostics;
  }
  for (const fragment of expectation.contains) {
    if (!text!.includes(fragment)) {
      diagnostics.push(`Artifact ${expectation.path} is missing required text ${JSON.stringify(fragment)}.`);
    }
  }
  for (const fragment of expectation.notContains) {
    if (text!.includes(fragment)) {
      diagnostics.push(`Artifact ${expectation.path} contains forbidden text ${JSON.stringify(fragment)}.`);
    }
  }
  if (expectation.json) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text!);
    } catch (error) {
      diagnostics.push(
        `Artifact ${expectation.path} must contain valid JSON: ${error instanceof Error ? error.message : String(error)}.`,
      );
      return diagnostics;
    }
    if (!jsonContains(parsed, expectation.json)) {
      diagnostics.push(`Artifact ${expectation.path} JSON does not contain the expected object subset.`);
    }
  }
  return diagnostics;
}

async function isolateWorkspaceSkills(options: {
  workspaceRoot: string;
  skillNames: string[];
}): Promise<string[]> {
  const skillsRoot = path.join(options.workspaceRoot, '.agents', 'skills');
  const allowed = new Set(options.skillNames);
  const entries = await fs.readdir(skillsRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  await Promise.all(entries.map(async (entry) => {
    if (allowed.has(entry)) return;
    await fs.remove(path.join(skillsRoot, entry));
  }));
  const roots = options.skillNames.map((skillName) => path.join(skillsRoot, skillName));
  for (const root of roots) {
    if (!(await fs.pathExists(path.join(root, 'SKILL.md')))) {
      throw new Error(`Materialized eval Skill is missing: ${root}`);
    }
  }
  return roots;
}

function diffSnapshots(before: Map<string, string>, after: Map<string, string>): string[] {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths]
    .filter((entry) => before.get(entry) !== after.get(entry))
    .sort((left, right) => left.localeCompare(right));
}

export class EvalAppServerSession {
  private readonly process: AppServerProcess;
  private readonly processTreeId = randomUUID();
  private readonly processTreeMonitor: ChildProcessTreeMonitor;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly handlers = new Set<AppServerFrameHandler>();
  private readonly failureHandlers = new Set<(error: Error) => void>();
  private stdoutBuffer = '';
  private stderrBuffer = '';
  private nextId = 1;
  private terminalError?: Error;
  private closing = false;
  private readonly closed: Promise<void>;
  private resolveClosed?: () => void;
  private cleanupPromise?: Promise<void>;
  private unregisterSignalCleanup = (): void => undefined;

  constructor(options: {
    codexBin: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
    modelProvider: string;
    sensitiveEnvironmentNames: string[];
    isolation: PluginEvalIsolation;
    processManagement?: PluginEvalProcessManagementEvidence;
    configOverrides?: readonly string[];
  }) {
    assertCodexEvalCanStartWork();
    const processManagement = options.processManagement ?? DEFAULT_MANAGED_PROCESS_EVIDENCE;
    const managed = processManagement.mode === 'managed';
    this.closed = new Promise<void>((resolve) => {
      this.resolveClosed = resolve;
    });
    const args = [
      'app-server',
      ...(options.isolation === 'strict' ? ['--strict-config'] : []),
      '--listen',
      'stdio://',
      '--config',
      'skills.include_instructions=true',
      '--config',
      `shell_environment_policy.exclude=${JSON.stringify([
        'CODEX_HOME',
        ...options.sensitiveEnvironmentNames,
      ])}`,
      '--config',
      `model_provider=${JSON.stringify(options.modelProvider)}`,
    ];
    for (const override of codexEvalConfigOverrides(options.isolation)) {
      args.push('--config', override);
    }
    for (const override of CODEX_EVAL_APP_SERVER_OVERRIDES) {
      args.push('--config', override);
    }
    for (const override of options.configOverrides ?? []) {
      args.push('--config', override);
    }
    this.process = spawn(options.codexBin, args, {
      cwd: options.cwd,
      env: managed
        ? { ...options.env, [CODEX_EVAL_PROCESS_TREE_ID_ENV]: this.processTreeId }
        : { ...options.env },
      shell: false,
      detached: managed && process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as unknown as AppServerProcess;
    this.processTreeMonitor = managed
      ? createChildProcessTreeMonitor(
          this.process as unknown as ChildProcess,
          { treeId: this.processTreeId },
        )
      : createDirectChildProcessMonitor(this.process as unknown as ChildProcess);
    this.process.stdout.setEncoding?.('utf8');
    this.process.stderr.setEncoding?.('utf8');
    this.process.stdout.on('data', (chunk: string | Buffer) => {
      this.handleChunk(
        (typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
          .replaceAll(this.processTreeId, '[process-tree-id]'),
      );
    });
    this.process.stderr.on('data', (chunk: string | Buffer) => {
      this.stderrBuffer = `${this.stderrBuffer}${String(chunk)}`
        .replaceAll(this.processTreeId, '[process-tree-id]')
        .slice(-32_000);
    });
    this.process.once('error', (error) => this.fail(error));
    this.process.once('close', (code, signal) => {
      this.resolveClosed?.();
      if (!this.closing) {
        this.fail(new Error(`codex app-server exited early (code=${code}, signal=${signal}).`));
      }
    });
    this.unregisterSignalCleanup = registerCodexEvalSignalCleanup(() => this.cleanup());
  }

  onFrame(handler: AppServerFrameHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  onFailure(handler: (error: Error) => void): () => void {
    this.failureHandlers.add(handler);
    if (this.terminalError) {
      handler(this.terminalError);
    }
    return () => this.failureHandlers.delete(handler);
  }

  async initialize(): Promise<void> {
    await this.sendRequest('initialize', {
      clientInfo: {
        name: 'aw-plugin-eval',
        title: 'Agent Workflows Plugin Eval',
        version: '1',
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
      },
    });
    await this.write({ method: 'initialized' });
  }

  async sendRequest(method: string, params: unknown, timeoutMs = 30_000): Promise<unknown> {
    if (this.terminalError) {
      throw this.terminalError;
    }
    const id = String(this.nextId++);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for app-server method ${method}.`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      void this.write({ id, method, params }).catch((error) => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  async respond(id: string | number, result: unknown): Promise<void> {
    await this.write({ id, result });
  }

  async cleanup(): Promise<void> {
    this.cleanupPromise ??= this.cleanupProcess();
    return this.cleanupPromise;
  }

  private async cleanupProcess(): Promise<void> {
    this.closing = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('app-server session closed.'));
    }
    this.pending.clear();
    try {
      await settleAppServerProcessCleanup({
        child: this.process as unknown as ChildProcess,
        processTreeMonitor: this.processTreeMonitor,
        waitForClose: (timeoutMs) => this.waitForClose(timeoutMs),
      });
    } finally {
      this.unregisterSignalCleanup();
    }
  }

  get stderr(): string {
    return this.stderrBuffer.replaceAll(this.processTreeId, '[process-tree-id]');
  }

  scrub<T>(value: T): T {
    return scrubProcessTreeId(value, this.processTreeId);
  }

  private async waitForClose(timeoutMs: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      this.closed.then(() => true as const),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    return result;
  }

  private async write(frame: Record<string, unknown>): Promise<void> {
    if (!this.process.stdin) {
      throw new Error('codex app-server stdin is unavailable.');
    }
    await new Promise<void>((resolve, reject) => {
      this.process.stdin.write(`${JSON.stringify(frame)}\n`, (error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  private handleChunk(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newlineIndex = this.stdoutBuffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).replace(/\r$/u, '');
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      this.handleLine(line);
      newlineIndex = this.stdoutBuffer.indexOf('\n');
    }
  }

  private handleLine(line: string): void {
    if (!line.trim()) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.fail(new Error(`Invalid app-server JSONL: ${line.slice(0, 240)}`));
      return;
    }
    if (!isRecord(parsed)) {
      return;
    }
    const id = requestId(parsed.id);
    if (id && ('result' in parsed || 'error' in parsed)) {
      const pending = this.pending.get(id);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timer);
      this.pending.delete(id);
      if ('error' in parsed) {
        pending.reject(new Error(
          `app-server ${pending.method} failed: ${JSON.stringify(parsed.error)}`,
        ));
      } else {
        pending.resolve(parsed.result);
      }
      return;
    }
    for (const handler of this.handlers) {
      void Promise.resolve(handler(parsed)).catch((error) => this.fail(
        error instanceof Error ? error : new Error(String(error)),
      ));
    }
  }

  private fail(error: Error): void {
    if (this.terminalError) {
      return;
    }
    this.terminalError = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const handler of this.failureHandlers) {
      handler(error);
    }
  }
}

async function collectStrictIsolationEvidence(options: {
  session: EvalAppServerSession;
  workspaceRoot: string;
  codexHome: string;
  allowedSkillRoots: string[];
}): Promise<CodexEvalRpcIsolationEvidence> {
  const [config, requirements] = await Promise.all([
    options.session.sendRequest('config/read', {
      includeLayers: true,
      cwd: options.workspaceRoot,
    }),
    options.session.sendRequest('configRequirements/read', {}),
  ]);
  validateCodexEvalConfigIsolation({
    config,
    requirements,
    codexHome: options.codexHome,
    workspaceRoot: options.workspaceRoot,
  });
  const [skills, mcpServers] = await Promise.all([
    options.session.sendRequest('skills/list', {
      cwds: [options.workspaceRoot],
      forceReload: true,
    }),
    options.session.sendRequest('mcpServerStatus/list', {
      cursor: null,
      limit: 100,
      detail: 'toolsAndAuthOnly',
      threadId: null,
    }),
  ]);
  return validateCodexEvalRpcIsolation({
    config,
    requirements,
    skills,
    mcpServers,
    codexHome: options.codexHome,
    workspaceRoot: options.workspaceRoot,
    allowedSkillRoots: options.allowedSkillRoots,
  });
}

function normalizeScriptedReply(value: unknown, label: string): ScriptedReply {
  if (typeof value === 'string') {
    return {
      expectedQuestionCount: 1,
      answersByIndex: [value],
      unexpectedQuestionAnswer: '我暂时不知道，请先处理已经回答的部分。',
    };
  }
  if (!isRecord(value)) {
    throw new Error(`${label} must be a string or object.`);
  }
  if (!Array.isArray(value.answers_by_index) || value.answers_by_index.some(
    (entry) => typeof entry !== 'string',
  )) {
    throw new Error(`${label}.answers_by_index must be an array of strings.`);
  }
  const expectedQuestionCount = value.expected_question_count;
  if (
    expectedQuestionCount !== undefined &&
    (!Number.isInteger(expectedQuestionCount) || (expectedQuestionCount as number) < 0)
  ) {
    throw new Error(`${label}.expected_question_count must be a non-negative integer.`);
  }
  const fallback = value.unexpected_question_answer;
  if (typeof fallback !== 'string' || fallback.trim() === '') {
    throw new Error(`${label}.unexpected_question_answer must be a non-empty string.`);
  }
  return {
    ...(expectedQuestionCount === undefined
      ? {}
      : { expectedQuestionCount: expectedQuestionCount as number }),
    answersByIndex: value.answers_by_index as string[],
    unexpectedQuestionAnswer: fallback,
  };
}

async function readConversationCases(
  casesPath: string,
  expectedSkill: string,
): Promise<ConversationEvalCase[]> {
  const raw = await fs.readJson(casesPath);
  const evals = validatePluginEvalConversationCaseDocument(raw, expectedSkill);
  return evals.map((value, index) => {
    const review = isRecord(value.review) ? value.review : {};
    if (
      typeof value.id !== 'string' ||
      typeof value.prompt !== 'string' ||
      !Array.isArray(value.scripted_replies) ||
      typeof value.expected_output !== 'string' ||
      !Array.isArray(review.checks) ||
      review.checks.some((entry) => typeof entry !== 'string')
    ) {
      throw new Error(`evals[${index}] has an invalid behavior case shape.`);
    }
    return {
      id: value.id.trim(),
      prompt: value.prompt,
      scriptedReplies: value.scripted_replies.map((entry, replyIndex) =>
        normalizeScriptedReply(entry, `evals[${index}].scripted_replies[${replyIndex}]`)),
      expectedOutput: value.expected_output,
      checks: review.checks as string[],
      workspaceUnchanged: review.workspace_unchanged === true,
      sandbox: value.sandbox === 'workspace-write' ? 'workspace-write' : 'read-only',
      allowedWorkspaceChanges: Array.isArray(review.allowed_workspace_changes)
        ? review.allowed_workspace_changes as string[]
        : [],
      artifacts: Array.isArray(review.artifacts)
        ? review.artifacts.map((artifact) => {
            const row = artifact as Record<string, unknown>;
            return {
              path: row.path as string,
              exists: row.exists !== false,
              contains: Array.isArray(row.contains) ? row.contains as string[] : [],
              notContains: Array.isArray(row.not_contains) ? row.not_contains as string[] : [],
              ...(isRecord(row.json) ? { json: row.json } : {}),
            };
          })
        : [],
    };
  });
}

export function extractAppServerThreadId(result: unknown): string {
  if (!isRecord(result) || !isRecord(result.thread) || typeof result.thread.id !== 'string') {
    throw new Error('app-server thread/start response is missing thread.id.');
  }
  return result.thread.id;
}

async function runConversationOnce(options: {
  sourceProjectRoot: string;
  evalCase: ConversationEvalCase;
  variant: AppServerRunEvidence['variant'];
  skillName: string;
  skillNames: string[];
  codexBin: string;
  model?: string;
  codexRuntime: CodexEvalRuntimeConfig;
  timeoutMs: number;
  sourceEnv: NodeJS.ProcessEnv;
  isolation: PluginEvalIsolation;
  processManagement: PluginEvalProcessManagementEvidence;
  forbiddenHostRoots: string[];
  workRoot?: string;
}): Promise<AppServerRunEvidence> {
  assertCodexEvalCanStartWork();
  const temporaryRoot = await createEvalTemporaryRoot(
    'conversation-',
    options.forbiddenHostRoots.length > 0 ? undefined : options.workRoot,
  );
  const runRoot = temporaryRoot.root;
  const workspaceRoot = path.join(runRoot, 'project');
  const codexHome = path.join(runRoot, 'codex-home');
  const diagnostics: string[] = [];
  const questions: AppServerRunEvidence['questions'] = [];
  const finalMessages: string[] = [];
  const eventTrace: unknown[] = [];
  let usage: unknown = null;
  let isolationEvidence: CodexEvalRpcIsolationEvidence | null = null;
  let session: EvalAppServerSession | undefined;
  let removeHandler: (() => void) | undefined;
  let removeFailureHandler: (() => void) | undefined;
  let turnTimer: ReturnType<typeof setTimeout> | undefined;
  const startedAt = Date.now();
  try {
    await fs.copy(options.sourceProjectRoot, workspaceRoot, { dereference: false });
    let allowedSkillRoots: string[] = [];
    if (options.isolation === 'strict') {
      const visibleSkills = options.variant === 'with_skill'
        ? options.skillNames
        : options.skillNames.filter((skillName) => skillName !== options.skillName);
      allowedSkillRoots = await isolateWorkspaceSkills({
        workspaceRoot,
        skillNames: visibleSkills,
      });
    } else if (options.variant === 'without_skill') {
      await fs.remove(path.join(workspaceRoot, '.agents', 'skills', options.skillName));
    }
    const env = buildIsolatedEnv(
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
    const before = await snapshotWorkspace(workspaceRoot);
    if (options.processManagement.mode === 'managed') {
      await assertProcessTreeInspectionAvailable();
    }
    assertCodexEvalCanStartWork();
    session = new EvalAppServerSession({
      codexBin: options.codexBin,
      cwd: workspaceRoot,
      env,
      modelProvider: options.codexRuntime.modelProvider,
      sensitiveEnvironmentNames: options.codexRuntime.sensitiveEnvironmentNames,
      isolation: options.isolation,
      processManagement: options.processManagement,
    });
    let replyStep = 0;
    let turnResolve: ((value: { complete: boolean }) => void) | undefined;
    let turnReject: ((error: Error) => void) | undefined;
    const turnDone = new Promise<{ complete: boolean }>((resolve, reject) => {
      turnResolve = resolve;
      turnReject = reject;
    });
    void turnDone.catch(() => undefined);
    removeFailureHandler = session.onFailure((error) => turnReject?.(error));
    turnTimer = setTimeout(() => {
      turnReject?.(new Error(`conversation turn timed out after ${options.timeoutMs}ms.`));
    }, options.timeoutMs);

    removeHandler = session.onFrame(async (frame) => {
      const method = typeof frame.method === 'string' ? frame.method : '';
      const params = isRecord(frame.params) ? frame.params : {};
      if (!method.startsWith('remoteControl/') && !method.startsWith('account/')) {
        eventTrace.push(frame);
      }
      const configWarning = inspectAppServerConfigWarning(frame);
      if (options.isolation === 'strict' && configWarning) {
        throw new Error(`Strict Codex eval received a config warning: ${configWarning}`);
      }
      if (method === 'item/tool/requestUserInput') {
        const responseId = appServerRequestId(frame.id);
        const id = requestId(responseId);
        if (!id || responseId === undefined || !Array.isArray(params.questions)) {
          throw new Error('requestUserInput frame is missing id or questions.');
        }
        const scripted = options.evalCase.scriptedReplies[replyStep];
        if (!scripted) {
          diagnostics.push(`Unexpected request_user_input step ${replyStep + 1}.`);
        }
        const fallback = scripted?.unexpectedQuestionAnswer ?? '请停止提问并交还控制。';
        const normalizedQuestions = params.questions.map((value, index) => {
          const row = isRecord(value) ? value : {};
          return {
            id: typeof row.id === 'string' ? row.id : `question-${index}`,
            header: typeof row.header === 'string' ? row.header : '',
            question: typeof row.question === 'string' ? row.question : '',
            options: Array.isArray(row.options)
              ? row.options.filter(isRecord).map((option) => ({
                  label: typeof option.label === 'string' ? option.label : '',
                  description: typeof option.description === 'string' ? option.description : '',
                }))
              : null,
          };
        });
        if (
          scripted?.expectedQuestionCount !== undefined &&
          scripted.expectedQuestionCount !== normalizedQuestions.length
        ) {
          diagnostics.push(
            `request_user_input step ${replyStep + 1} expected ${scripted.expectedQuestionCount} questions but received ${normalizedQuestions.length}.`,
          );
        }
        const answers = Object.fromEntries(normalizedQuestions.map((question, index) => [
          question.id,
          [scripted?.answersByIndex[index] ?? fallback],
        ]));
        questions.push({
          requestId: id,
          step: replyStep,
          questions: normalizedQuestions,
          answers,
        });
        replyStep += 1;
        await session!.respond(responseId, {
          answers: Object.fromEntries(
            Object.entries(answers).map(([key, value]) => [key, { answers: value }]),
          ),
        });
        return;
      }
      if (method === 'item/completed' && isRecord(params.item)) {
        const item = params.item;
        if (
          item.type === 'agentMessage' &&
          item.phase === 'final_answer' &&
          typeof item.text === 'string'
        ) {
          finalMessages.push(item.text);
        }
      }
      if (method === 'thread/tokenUsage/updated') {
        usage = params.tokenUsage ?? usage;
      }
      if (method === 'turn/completed') {
        const turn = isRecord(params.turn) ? params.turn : {};
        turnResolve?.({ complete: turn.status === 'completed' });
      }
      if (method === 'error') {
        turnReject?.(new Error(`app-server error: ${JSON.stringify(params)}`));
      }
    });

    await session.initialize();
    if (options.isolation === 'strict') {
      isolationEvidence = await collectStrictIsolationEvidence({
        session,
        workspaceRoot,
        codexHome,
        allowedSkillRoots,
      });
    }
    const sandboxPolicy = options.evalCase.sandbox === 'workspace-write'
      ? {
          type: 'workspaceWrite' as const,
          writableRoots: [workspaceRoot],
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: true,
        }
      : { type: 'readOnly' as const, networkAccess: true };
    const threadResult = await session.sendRequest('thread/start', {
      cwd: workspaceRoot,
      approvalPolicy: 'never',
      sandbox: options.evalCase.sandbox,
      ephemeral: false,
      ...(options.model ? { model: options.model } : {}),
    });
    const threadId = extractAppServerThreadId(threadResult);
    await session.sendRequest('turn/start', {
      threadId,
      input: [{ type: 'text', text: options.evalCase.prompt, text_elements: [] }],
      cwd: workspaceRoot,
      approvalPolicy: 'never',
      sandboxPolicy,
      ...(options.model ? { model: options.model } : {}),
    });
    const completed = await turnDone;
    clearTimeout(turnTimer);
    turnTimer = undefined;
    removeHandler();
    removeHandler = undefined;
    removeFailureHandler();
    removeFailureHandler = undefined;
    const after = await snapshotWorkspace(workspaceRoot);
    const workspaceChanges = diffSnapshots(before, after);
    const workspaceArtifacts = await Promise.all(
      options.evalCase.artifacts.map((expectation) =>
        readWorkspaceArtifactEvidence(workspaceRoot, expectation)),
    );
    const hostSourceAccessAbsent = options.forbiddenHostRoots.length > 0
      ? !containsForbiddenHostRoot(eventTrace, options.forbiddenHostRoots)
      : null;
    if (hostSourceAccessAbsent === false) {
      diagnostics.push('Codex eval accessed a forbidden host source root.');
    }
    if (replyStep < options.evalCase.scriptedReplies.length) {
      diagnostics.push(
        `${options.evalCase.scriptedReplies.length - replyStep} scripted reply step(s) were unused.`,
      );
    }
    if (options.evalCase.workspaceUnchanged && workspaceChanges.length > 0) {
      diagnostics.push(`Workspace changed: ${workspaceChanges.join(', ')}`);
    }
    if (options.evalCase.sandbox === 'workspace-write') {
      const unexpectedChanges = workspaceChanges.filter((relativePath) =>
        !options.evalCase.allowedWorkspaceChanges.some((pattern) =>
          workspacePathMatchesPattern(relativePath, pattern)));
      if (unexpectedChanges.length > 0) {
        diagnostics.push(`Workspace changed outside the allowed paths: ${unexpectedChanges.join(', ')}`);
      }
    }
    if (options.variant === 'with_skill') {
      for (const [index, expectation] of options.evalCase.artifacts.entries()) {
        diagnostics.push(...validateWorkspaceArtifact(expectation, workspaceArtifacts[index]!));
      }
    }
    return session.scrub({
      variant: options.variant,
      complete: completed.complete,
      mechanicalPassed: completed.complete && diagnostics.length === 0,
      hostSourceAccessAbsent,
      durationMs: Date.now() - startedAt,
      questions,
      finalMessages,
      usage,
      workspaceChanges,
      workspaceArtifacts,
      diagnostics,
      eventTrace,
      isolation: isolationEvidence,
      ...(session.stderr.trim() ? { stderr: session.stderr.trim() } : {}),
    });
  } catch (error) {
    const hostSourceAccessAbsent = options.forbiddenHostRoots.length > 0 &&
      containsForbiddenHostRoot(eventTrace, options.forbiddenHostRoots)
      ? false
      : null;
    const evidence: AppServerRunEvidence = {
      variant: options.variant,
      complete: false,
      mechanicalPassed: false,
      hostSourceAccessAbsent,
      durationMs: Date.now() - startedAt,
      questions,
      finalMessages,
      usage,
      workspaceChanges: [],
      workspaceArtifacts: [],
      diagnostics: [error instanceof Error ? error.stack ?? error.message : String(error)],
      eventTrace,
      isolation: isolationEvidence,
      ...(session?.stderr.trim() ? { stderr: session.stderr.trim() } : {}),
    };
    return session ? session.scrub(evidence) : evidence;
  } finally {
    if (turnTimer) {
      clearTimeout(turnTimer);
    }
    removeHandler?.();
    removeFailureHandler?.();
    try {
      await session?.cleanup();
    } finally {
      await temporaryRoot.cleanup();
    }
  }
}

export async function runCodexEvalIsolationProbe(options: {
  subjectRoot: string;
  skillName: string;
  skillNames?: string[];
  codexBin: string;
  codexRuntime: CodexEvalRuntimeConfig;
  sourceEnv?: NodeJS.ProcessEnv;
  processManagement?: PluginEvalProcessManagementEvidence;
  workRoot?: string;
}): Promise<CodexEvalRpcIsolationEvidence> {
  assertCodexEvalCanStartWork();
  const sourceEnv = options.sourceEnv ?? process.env;
  const processManagement = options.processManagement ?? DEFAULT_MANAGED_PROCESS_EVIDENCE;
  const temporaryRoot = await createEvalTemporaryRoot(
    'isolation-probe-',
    options.workRoot,
  );
  const workspaceRoot = path.join(temporaryRoot.root, 'project');
  const codexHome = path.join(temporaryRoot.root, 'codex-home');
  let session: EvalAppServerSession | undefined;
  try {
    await fs.copy(options.subjectRoot, workspaceRoot, { dereference: false });
    const allowedSkillRoots = await isolateWorkspaceSkills({
      workspaceRoot,
      skillNames: options.skillNames ?? [options.skillName],
    });
    const env = buildIsolatedEnv(
      sourceEnv,
      temporaryRoot.root,
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
    if (processManagement.mode === 'managed') {
      await assertProcessTreeInspectionAvailable();
    }
    session = new EvalAppServerSession({
      codexBin: options.codexBin,
      cwd: workspaceRoot,
      env,
      modelProvider: options.codexRuntime.modelProvider,
      sensitiveEnvironmentNames: options.codexRuntime.sensitiveEnvironmentNames,
      isolation: 'strict',
      processManagement,
    });
    await session.initialize();
    return await collectStrictIsolationEvidence({
      session,
      workspaceRoot,
      codexHome,
      allowedSkillRoots,
    });
  } finally {
    try {
      await session?.cleanup();
    } finally {
      await temporaryRoot.cleanup();
    }
  }
}

export async function runCodexConversationSuite(options: {
  suiteId: string;
  skillName: string;
  skillNames?: string[];
  casesPath: string;
  subjectRoot: string;
  profile: string;
  runs: number;
  caseId?: string;
  caseIds?: string[];
  codexBin: string;
  model?: string;
  codexRuntime?: CodexEvalRuntimeConfig;
  timeoutMs: number;
  isolation?: PluginEvalIsolation;
  sourceEnv?: NodeJS.ProcessEnv;
  reportPath?: string;
  processManagement?: PluginEvalProcessManagementEvidence;
  forbiddenHostRoots?: string[];
  workRoot?: string;
  onCaseCompleted?: (checkpoint: PluginEvalCaseCheckpoint) => Promise<void>;
  stopOnIncomplete?: boolean;
}): Promise<PluginEvalSuiteReport> {
  const skillNames = options.skillNames ?? [options.skillName];
  const sourceEnv = options.sourceEnv ?? process.env;
  const codexRuntime = options.codexRuntime ?? cleanCodexEvalRuntimeConfig(sourceEnv, options.model);
  const model = options.model ?? codexRuntime.model ?? undefined;
  const isolation = options.isolation ?? 'standard';
  const processManagement = options.processManagement ?? DEFAULT_MANAGED_PROCESS_EVIDENCE;
  const forbiddenHostRoots = await canonicalForbiddenHostRoots(
    [options.subjectRoot, ...(options.forbiddenHostRoots ?? [])],
  );
  let cases = await readConversationCases(options.casesPath, options.skillName);
  if (options.caseId && options.caseIds) {
    throw new Error('runCodexConversationSuite cannot combine caseId and caseIds.');
  }
  if (options.caseId) {
    cases = cases.filter((entry) => entry.id === options.caseId);
    if (cases.length === 0) {
      throw new Error(`Unknown conversation case: ${options.caseId}`);
    }
  }
  if (options.caseIds) {
    const requested = new Set(options.caseIds);
    cases = cases.filter((entry) => requested.has(entry.id));
    const found = new Set(cases.map((entry) => entry.id));
    const missing = [...requested].filter((id) => !found.has(id));
    if (missing.length > 0) {
      throw new Error(`Unknown conversation cases: ${missing.join(', ')}`);
    }
  }
  let hostIsolation: CodexEvalHostIsolationEvidence | null = null;
  try {
    if (isolation === 'strict') {
      hostIsolation = await inspectCodexEvalHostIsolation({ sourceEnv });
    }
  } catch (error) {
    const diagnostic = error instanceof Error ? error.stack ?? error.message : String(error);
    const report = redactCodexEvalValue({
      schema_version: 1,
      generated_at: new Date().toISOString(),
      suite: options.suiteId,
      owner_skill: options.skillName,
      participant_skills: skillNames,
      profile: options.profile,
      complete: false,
      mechanical_passed: false,
      qualitative_review: 'required',
      environment_error: diagnostic,
      environment: {
        isolation: codexEvalIsolationEvidence({ mode: isolation }),
        codex_runtime: codexEvalRuntimeEvidence(codexRuntime),
      },
      results: [],
    }, codexRuntime);
    if (options.reportPath) {
      await fs.ensureDir(path.dirname(options.reportPath));
      await writeJsonAtomic(options.reportPath, report);
    }
    return redactCodexEvalValue({
      id: options.suiteId,
      kind: 'conversation',
      skills: skillNames,
      profile: options.profile,
      split: null,
      outcome: 'incomplete',
      complete: false,
      mechanicalPassed: false,
      qualitativeReview: 'required',
      ...(options.reportPath ? { reportPath: options.reportPath } : {}),
      summary: { cases: cases.length, runs: 0 },
      diagnostics: [diagnostic],
    }, codexRuntime);
  }
  const allRunsFor = (caseResults: ConversationCaseResult[]): AppServerRunEvidence[] =>
    caseResults.flatMap((entry) => entry.runs).flatMap((run) => [
      run.with_skill,
      run.without_skill,
    ]);
  const createSuiteReport = (
    caseResults: ConversationCaseResult[],
    reportPath = options.reportPath,
  ): PluginEvalSuiteReport => {
    const allRuns = allRunsFor(caseResults);
    const complete = caseResults.length > 0 && allRuns.every((run) => run.complete);
    const mechanicalPassed = complete && allRuns.every((run) => run.mechanicalPassed);
    return redactCodexEvalValue({
      id: options.suiteId,
      kind: 'conversation',
      skills: skillNames,
      profile: options.profile,
      split: null,
      outcome: !complete ? 'incomplete' : !mechanicalPassed ? 'failed' : 'needs_review',
      complete,
      mechanicalPassed,
      qualitativeReview: 'required',
      ...(reportPath ? { reportPath } : {}),
      caseResults: caseResults.map((result) => {
        const runs = allRunsFor([result]);
        const caseComplete = runs.every((run) => run.complete);
        const caseMechanicalPassed = caseComplete && runs.every((run) => run.mechanicalPassed);
        return {
          id: result.id,
          outcome: !caseComplete
            ? 'incomplete'
            : !caseMechanicalPassed
              ? 'failed'
              : 'needs_review',
          complete: caseComplete,
          mechanicalPassed: caseMechanicalPassed,
          qualitativeReview: 'required',
          summary: { runs: runs.length },
          diagnostics: runs.flatMap((run) => run.diagnostics),
        };
      }),
      summary: { cases: caseResults.length, runs: allRuns.length },
      diagnostics: allRuns.flatMap((run) => run.diagnostics),
    }, codexRuntime) as PluginEvalSuiteReport;
  };
  const writeProgressReport = async (
    caseResults: ConversationCaseResult[],
  ): Promise<void> => {
    if (!options.reportPath) return;
    const allRuns = allRunsFor(caseResults);
    const complete = caseResults.length === cases.length && allRuns.every((run) => run.complete);
    const mechanicalPassed = complete && allRuns.every((run) => run.mechanicalPassed);
    const runtimeProbe = allRuns.find((run) => run.isolation)?.isolation ?? null;
    const report = redactCodexEvalValue({
      schema_version: 1,
      generated_at: new Date().toISOString(),
      suite: options.suiteId,
      owner_skill: options.skillName,
      participant_skills: skillNames,
      profile: options.profile,
      complete,
      mechanical_passed: mechanicalPassed,
      qualitative_review: 'required',
      environment: {
        isolation: codexEvalIsolationEvidence({
          mode: isolation,
          host: hostIsolation,
          runtimeProbe,
        }),
        codex_runtime: codexEvalRuntimeEvidence(codexRuntime),
      },
      results: caseResults,
    }, codexRuntime);
    await writeJsonAtomic(options.reportPath, report);
  };

  const results: ConversationCaseResult[] = [];
  for (const evalCase of cases) {
    const runs = [];
    for (let runIndex = 0; runIndex < options.runs; runIndex += 1) {
      assertCodexEvalCanStartWork();
      const withSkill = await runConversationOnce({
        sourceProjectRoot: options.subjectRoot,
        evalCase,
        variant: 'with_skill',
        skillName: options.skillName,
        skillNames,
        codexBin: options.codexBin,
        model,
        codexRuntime,
        timeoutMs: options.timeoutMs,
        sourceEnv,
        isolation,
        processManagement,
        forbiddenHostRoots,
        workRoot: options.workRoot,
      });
      assertCodexEvalCanStartWork();
      const withoutSkill = await runConversationOnce({
        sourceProjectRoot: options.subjectRoot,
        evalCase,
        variant: 'without_skill',
        skillName: options.skillName,
        skillNames,
        codexBin: options.codexBin,
        model,
        codexRuntime,
        timeoutMs: options.timeoutMs,
        sourceEnv,
        isolation,
        processManagement,
        forbiddenHostRoots,
        workRoot: options.workRoot,
      });
      runs.push({ run: runIndex + 1, with_skill: withSkill, without_skill: withoutSkill });
    }
    const caseResult: ConversationCaseResult = {
      id: evalCase.id,
      prompt: evalCase.prompt,
      expected_output: evalCase.expectedOutput,
      checks: evalCase.checks,
      runs,
    };
    results.push(caseResult);
    await writeProgressReport(results);
    await options.onCaseCompleted?.({
      caseId: evalCase.id,
      report: createSuiteReport([caseResult]),
    });
    if (options.stopOnIncomplete && !createSuiteReport([caseResult]).complete) break;
  }
  const allRuns = allRunsFor(results);
  const complete = results.length === cases.length && allRuns.every((run) => run.complete);
  const mechanicalPassed = complete && allRuns.every((run) => run.mechanicalPassed);
  await writeProgressReport(results);
  return {
    ...createSuiteReport(results),
    complete,
    mechanicalPassed,
    outcome: !complete ? 'incomplete' : !mechanicalPassed ? 'failed' : 'needs_review',
  };
}
