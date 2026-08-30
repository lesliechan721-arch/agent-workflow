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
  createCodexEvalTemporaryRoot,
  materializeCodexEvalRuntimeHome,
  registerCodexEvalSignalCleanup,
  type CodexEvalRuntimeConfig,
} from './codex-eval-runtime-config.js';
import {
  codexEvalConfigOverrides,
  validateCodexEvalConfigIsolation,
  validateCodexEvalRpcIsolation,
  type CodexEvalRpcIsolationEvidence,
} from './codex-eval-isolation.js';
import { validateAwSkillEvalConversationCaseDocument } from './aw-skill-eval-cases.js';
import type { AwSkillEvalIsolation } from '../src/eval/manifest.js';

export interface CodexEvalProcessManagementEvidence {
  mode: 'managed' | 'observed' | 'unmanaged-confirmed' | 'not-applicable';
  inspectionAvailable: boolean;
  userAcknowledged: boolean;
  descendantCleanupGuaranteed: boolean;
  limitation?: string;
  diagnostic?: string;
}

const DEFAULT_OBSERVED_PROCESS_EVIDENCE: CodexEvalProcessManagementEvidence = {
  mode: 'observed',
  inspectionAvailable: true,
  userAcknowledged: false,
  descendantCleanupGuaranteed: false,
  limitation:
    'Process-tree inspection observes and cleans known descendants but does not guarantee descendant cleanup.',
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

export interface ConversationEvalCase {
  id: string;
  prompt: string;
  scriptedReplies: ScriptedReply[];
  expectedOutput: string;
  checks: string[];
  workspaceFiles: Record<string, string>;
  workspaceUnchanged: boolean;
  sandbox: 'read-only' | 'workspace-write';
  allowedWorkspaceChanges: string[];
  artifacts: WorkspaceArtifactExpectation[];
  environmentPathPrepend: string[];
}

export interface AppServerRunEvidence {
  variant: 'with_skill' | 'without_skill';
  complete: boolean;
  mechanicalPassed: boolean;
  hostSourceAccessAbsent: boolean | null;
  scriptedReplyMismatches: string[];
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

function isPathInsideOrEqual(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
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

function commandInputContainsForbiddenHostRoot(
  value: Record<string, unknown>,
  forbiddenHostRoots: string[],
): boolean {
  const commandActions = Array.isArray(value.commandActions)
    ? value.commandActions.filter(isRecord).map((action) => ({
        command: action.command,
        path: action.path,
      }))
    : [];
  return containsForbiddenHostRoot([
    value.command,
    value.cwd,
    commandActions,
  ], forbiddenHostRoots);
}

function eventContainsForbiddenHostSourceInput(
  value: unknown,
  forbiddenHostRoots: string[],
): boolean {
  if (!isRecord(value)) return false;
  const params = isRecord(value.params) ? value.params : {};
  if (value.method === 'item/commandExecution/requestApproval') {
    return commandInputContainsForbiddenHostRoot(params, forbiddenHostRoots)
      || containsForbiddenHostRoot(params.additionalPermissions, forbiddenHostRoots);
  }
  if (value.method === 'item/fileChange/requestApproval') {
    return containsForbiddenHostRoot(params.grantRoot, forbiddenHostRoots);
  }

  const item = isRecord(params.item) ? params.item : null;
  if (item?.type === 'commandExecution') {
    return commandInputContainsForbiddenHostRoot(item, forbiddenHostRoots);
  }
  if (item?.type === 'fileChange' && Array.isArray(item.changes)) {
    const paths = item.changes.filter(isRecord).map((change) => ({
      path: change.path,
      movePath: isRecord(change.kind) ? change.kind.move_path : undefined,
    }));
    return containsForbiddenHostRoot(paths, forbiddenHostRoots);
  }
  if (item?.type === 'imageView') {
    return containsForbiddenHostRoot(item.path, forbiddenHostRoots);
  }
  return false;
}

function eventTraceContainsForbiddenHostSourceInput(
  eventTrace: unknown[],
  forbiddenHostRoots: string[],
): boolean {
  return eventTrace.some((event) =>
    eventContainsForbiddenHostSourceInput(event, forbiddenHostRoots));
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

function workspaceChangeIsAllowed(relativePath: string, patterns: string[]): boolean {
  if (patterns.some((pattern) => workspacePathMatchesPattern(relativePath, pattern))) {
    return true;
  }
  if (!relativePath.endsWith('/')) return false;
  const directoryPath = relativePath.slice(0, -1);
  return patterns.some((pattern) => {
    const allowedPath = pattern.endsWith('/**') ? pattern.slice(0, -3) : pattern;
    return allowedPath.startsWith(`${directoryPath}/`);
  });
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
    isolation: AwSkillEvalIsolation;
    processManagement?: CodexEvalProcessManagementEvidence;
    configOverrides?: readonly string[];
  }) {
    assertCodexEvalCanStartWork();
    const processManagement = options.processManagement ?? DEFAULT_OBSERVED_PROCESS_EVIDENCE;
    const managed = processManagement.mode === 'managed' || processManagement.mode === 'observed';
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
        name: 'aw-skill-eval-provider',
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

function normalizeConversationCase(
  value: Record<string, unknown>,
  index: number,
): ConversationEvalCase {
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
      workspaceFiles: isRecord(value.workspace_files)
        ? Object.fromEntries(Object.entries(value.workspace_files).map(([relativePath, content]) => [
            relativePath,
            content as string,
          ]))
        : {},
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
      environmentPathPrepend: isRecord(value.environment) &&
        Array.isArray(value.environment.pathPrepend)
        ? value.environment.pathPrepend as string[]
        : [],
    };
}

export function normalizeConversationProviderCase(options: {
  value: Record<string, unknown>;
  expectedSkill: string;
  fixtureRoot: string;
  suitePathPrepend?: string[];
}): ConversationEvalCase {
  const [value] = validateAwSkillEvalConversationCaseDocument(
    { skill_name: options.expectedSkill, evals: [options.value] },
    options.expectedSkill,
    'conversation provider case',
    options.fixtureRoot,
    options.suitePathPrepend,
  );
  return normalizeConversationCase(value!, 0);
}

async function assertFixtureTreeSafe(root: string, target: string, label: string): Promise<void> {
  const rootRealPath = await fs.realpath(root);
  const targetRealPath = await fs.realpath(target);
  if (!isPathInsideOrEqual(rootRealPath, targetRealPath)) {
    throw new Error(`${label} must stay inside its Eval fixture root.`);
  }
  const relative = path.relative(root, target);
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) throw new Error(`${label} must not contain symbolic links.`);
  }
  const stat = await fs.lstat(target);
  if (stat.isFile()) return;
  if (!stat.isDirectory()) throw new Error(`${label} must be a regular file or directory.`);
  const entries = await fs.readdir(target);
  for (const entry of entries) {
    await assertFixtureTreeSafe(root, path.join(target, entry), label);
  }
}

async function makeFixtureExecutable(target: string): Promise<void> {
  const stat = await fs.lstat(target);
  if (stat.isFile()) {
    await fs.chmod(target, 0o755);
    return;
  }
  if (!stat.isDirectory()) return;
  for (const entry of await fs.readdir(target)) {
    await makeFixtureExecutable(path.join(target, entry));
  }
}

async function materializeConversationEnvironment(options: {
  workspaceRoot: string;
  fixtures: Array<{ fixtureRoot: string; relativePath: string }>;
}): Promise<string[]> {
  const pathEntries: string[] = [];
  const materialized = new Map<string, string>();
  for (const { fixtureRoot, relativePath } of options.fixtures) {
    const source = path.resolve(fixtureRoot, relativePath);
    await assertFixtureTreeSafe(
      fixtureRoot,
      source,
      `Conversation PATH fixture ${JSON.stringify(relativePath)}`,
    );
    const target = path.resolve(options.workspaceRoot, relativePath);
    if (!isPathInsideOrEqual(options.workspaceRoot, target)) {
      throw new Error(`Conversation PATH fixture must stay inside the eval workspace: ${relativePath}`);
    }
    const sourceRealPath = await fs.realpath(source);
    const previousSource = materialized.get(target);
    if (previousSource) {
      if (previousSource !== sourceRealPath) {
        throw new Error(`Conversation PATH fixtures conflict at: ${relativePath}`);
      }
      continue;
    }
    if (await fs.pathExists(target)) {
      throw new Error(`Conversation PATH fixture conflicts with materialized subject: ${relativePath}`);
    }
    await fs.copy(source, target, { dereference: false, errorOnExist: true, overwrite: false });
    await makeFixtureExecutable(target);
    materialized.set(target, sourceRealPath);
    const stat = await fs.lstat(target);
    pathEntries.push(stat.isDirectory() ? target : path.dirname(target));
  }
  return pathEntries;
}

async function materializeConversationWorkspaceFiles(
  workspaceRoot: string,
  workspaceFiles: Record<string, string>,
): Promise<void> {
  for (const [relativePath, content] of Object.entries(workspaceFiles)) {
    const segments = relativePath.split('/');
    const fileName = segments.pop()!;
    let parent = workspaceRoot;
    for (const segment of segments) {
      parent = path.join(parent, segment);
      if (await fs.pathExists(parent)) {
        const stat = await fs.lstat(parent);
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
          throw new Error(
            `Conversation workspace file has an unsafe parent path: ${relativePath}`,
          );
        }
      } else {
        await fs.mkdir(parent);
      }
    }
    const target = path.join(parent, fileName);
    if (await fs.pathExists(target)) {
      throw new Error(
        `Conversation workspace file conflicts with materialized subject: ${relativePath}`,
      );
    }
    await fs.writeFile(target, content, 'utf8');
  }
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
  isolation: AwSkillEvalIsolation;
  processManagement: CodexEvalProcessManagementEvidence;
  forbiddenHostRoots: string[];
  workRoot?: string;
  environmentFixtures: Array<{ fixtureRoot: string; relativePath: string }>;
  manageTimeout?: boolean;
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
  const scriptedReplyMismatches: string[] = [];
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
    const environmentPathEntries = await materializeConversationEnvironment({
      workspaceRoot,
      fixtures: options.environmentFixtures,
    });
    await materializeConversationWorkspaceFiles(workspaceRoot, options.evalCase.workspaceFiles);
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
    env.PATH = [...environmentPathEntries, env.PATH].filter(Boolean).join(path.delimiter);
    await Promise.all([
      fs.ensureDir(env.HOME!),
      fs.ensureDir(env.TMPDIR!),
      materializeCodexEvalRuntimeHome(options.codexRuntime, codexHome, {
        trustedProject: workspaceRoot,
      }),
    ]);
    const before = await snapshotWorkspace(workspaceRoot);
    if (
      options.processManagement.mode === 'managed' ||
      options.processManagement.mode === 'observed'
    ) {
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
    if (options.manageTimeout !== false) {
      turnTimer = setTimeout(() => {
        turnReject?.(new Error(`conversation turn timed out after ${options.timeoutMs}ms.`));
      }, options.timeoutMs);
    }

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
          scriptedReplyMismatches.push(`Unexpected request_user_input step ${replyStep + 1}.`);
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
          scriptedReplyMismatches.push(
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
      ? !eventTraceContainsForbiddenHostSourceInput(eventTrace, options.forbiddenHostRoots)
      : null;
    if (hostSourceAccessAbsent === false) {
      diagnostics.push('Codex eval accessed a forbidden host source root.');
    }
    if (replyStep < options.evalCase.scriptedReplies.length) {
      scriptedReplyMismatches.push(
        `${options.evalCase.scriptedReplies.length - replyStep} scripted reply step(s) were unused.`,
      );
    }
    if (options.evalCase.workspaceUnchanged && workspaceChanges.length > 0) {
      diagnostics.push(`Workspace changed: ${workspaceChanges.join(', ')}`);
    }
    if (options.evalCase.sandbox === 'workspace-write') {
      const unexpectedChanges = workspaceChanges.filter((relativePath) =>
        !workspaceChangeIsAllowed(relativePath, options.evalCase.allowedWorkspaceChanges));
      if (unexpectedChanges.length > 0) {
        diagnostics.push(`Workspace changed outside the allowed paths: ${unexpectedChanges.join(', ')}`);
      }
    }
    if (options.variant === 'with_skill') {
      diagnostics.push(...scriptedReplyMismatches);
      for (const [index, expectation] of options.evalCase.artifacts.entries()) {
        diagnostics.push(...validateWorkspaceArtifact(expectation, workspaceArtifacts[index]!));
      }
    }
    return session.scrub({
      variant: options.variant,
      complete: completed.complete,
      mechanicalPassed: completed.complete && diagnostics.length === 0,
      hostSourceAccessAbsent,
      scriptedReplyMismatches,
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
      eventTraceContainsForbiddenHostSourceInput(eventTrace, options.forbiddenHostRoots)
      ? false
      : null;
    const evidence: AppServerRunEvidence = {
      variant: options.variant,
      complete: false,
      mechanicalPassed: false,
      hostSourceAccessAbsent,
      scriptedReplyMismatches,
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

export async function runCodexConversationProviderCase(options: {
  evalCase: ConversationEvalCase;
  sourceProjectRoot: string;
  skillMode: 'with-skill' | 'without-skill' | 'previous-version';
  skillName: string;
  skillNames: string[];
  codexBin: string;
  model?: string;
  codexRuntime: CodexEvalRuntimeConfig;
  timeoutMs: number;
  sourceEnv?: NodeJS.ProcessEnv;
  isolation: AwSkillEvalIsolation;
  forbiddenHostRoots?: string[];
  environmentFixtures: Array<{ fixtureRoot: string; relativePath: string }>;
}): Promise<AppServerRunEvidence> {
  return runConversationOnce({
    sourceProjectRoot: options.sourceProjectRoot,
    evalCase: options.evalCase,
    variant: options.skillMode === 'without-skill' ? 'without_skill' : 'with_skill',
    skillName: options.skillName,
    skillNames: options.skillNames,
    codexBin: options.codexBin,
    ...(options.model ? { model: options.model } : {}),
    codexRuntime: options.codexRuntime,
    timeoutMs: options.timeoutMs,
    sourceEnv: options.sourceEnv ?? process.env,
    isolation: options.isolation,
    processManagement: {
      mode: 'unmanaged-confirmed',
      inspectionAvailable: false,
      userAcknowledged: true,
      descendantCleanupGuaranteed: false,
      limitation: 'The AwSkillEval engine owns the provider process tree and timeout.',
    },
    forbiddenHostRoots: await canonicalForbiddenHostRoots(
      [options.sourceProjectRoot, ...(options.forbiddenHostRoots ?? [])],
    ),
    environmentFixtures: options.environmentFixtures,
    manageTimeout: false,
  });
}

export async function runCodexEvalIsolationProbe(options: {
  subjectRoot: string;
  skillName: string;
  skillNames?: string[];
  codexBin: string;
  codexRuntime: CodexEvalRuntimeConfig;
  sourceEnv?: NodeJS.ProcessEnv;
  processManagement?: CodexEvalProcessManagementEvidence;
}): Promise<CodexEvalRpcIsolationEvidence> {
  assertCodexEvalCanStartWork();
  const sourceEnv = options.sourceEnv ?? process.env;
  const processManagement = options.processManagement ?? DEFAULT_OBSERVED_PROCESS_EVIDENCE;
  const temporaryRoot = await createEvalTemporaryRoot('isolation-probe-');
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
    if (processManagement.mode === 'managed' || processManagement.mode === 'observed') {
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
