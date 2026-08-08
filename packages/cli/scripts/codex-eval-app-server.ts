import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';

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
  validatePluginEvalConversationCaseDocument,
  type PluginEvalSuiteReport,
} from './plugin-eval-contract.js';

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

interface ConversationEvalCase {
  id: string;
  prompt: string;
  scriptedReplies: ScriptedReply[];
  expectedOutput: string;
  checks: string[];
  workspaceUnchanged: boolean;
}

interface AppServerRunEvidence {
  variant: 'with_skill' | 'without_skill';
  complete: boolean;
  mechanicalPassed: boolean;
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
  diagnostics: string[];
  eventTrace: unknown[];
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requestId(value: unknown): string | undefined {
  if (typeof value === 'string' || typeof value === 'number') {
    return String(value);
  }
  return undefined;
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
      if (entry.name === '.git' || entry.name === '.codex' || entry.name === '.agents') {
        continue;
      }
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath);
      } else if (entry.isFile()) {
        const relativePath = path.relative(root, absolutePath).split(path.sep).join('/');
        snapshot.set(
          relativePath,
          createHash('sha256').update(await fs.readFile(absolutePath)).digest('hex'),
        );
      }
    }
  }
  await visit(root);
  return snapshot;
}

function diffSnapshots(before: Map<string, string>, after: Map<string, string>): string[] {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths]
    .filter((entry) => before.get(entry) !== after.get(entry))
    .sort((left, right) => left.localeCompare(right));
}

class EvalAppServerSession {
  private readonly process: AppServerProcess;
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
  }) {
    assertCodexEvalCanStartWork();
    this.closed = new Promise<void>((resolve) => {
      this.resolveClosed = resolve;
    });
    this.process = spawn(options.codexBin, [
      'app-server',
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
    ], {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as unknown as AppServerProcess;
    this.process.stdout.setEncoding?.('utf8');
    this.process.stderr.setEncoding?.('utf8');
    this.process.stdout.on('data', (chunk: string | Buffer) => {
      this.handleChunk(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    });
    this.process.stderr.on('data', (chunk: string | Buffer) => {
      this.stderrBuffer = `${this.stderrBuffer}${String(chunk)}`.slice(-32_000);
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

  async respond(id: string, result: unknown): Promise<void> {
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
      const diagnostics = await terminateChildProcessTree(
        this.process as unknown as ChildProcess,
      );
      if (await this.waitForClose(1_000)) return;
      releaseChildProcessHandles(this.process as unknown as ChildProcess);
      throw new Error(
        `Could not confirm Codex app-server process-tree termination. ${diagnostics.join(' ')}`.trim(),
      );
    } finally {
      this.unregisterSignalCleanup();
    }
  }

  get stderr(): string {
    return this.stderrBuffer;
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
    };
  });
}

function extractThreadId(result: unknown): string {
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
  codexBin: string;
  model?: string;
  codexRuntime: CodexEvalRuntimeConfig;
  timeoutMs: number;
  sourceEnv: NodeJS.ProcessEnv;
}): Promise<AppServerRunEvidence> {
  assertCodexEvalCanStartWork();
  const temporaryRoot = await createCodexEvalTemporaryRoot('aw-ask-me-eval-');
  const runRoot = temporaryRoot.root;
  const workspaceRoot = path.join(runRoot, 'project');
  const codexHome = path.join(runRoot, 'codex-home');
  const diagnostics: string[] = [];
  const questions: AppServerRunEvidence['questions'] = [];
  const finalMessages: string[] = [];
  const eventTrace: unknown[] = [];
  let usage: unknown = null;
  let session: EvalAppServerSession | undefined;
  let removeHandler: (() => void) | undefined;
  let removeFailureHandler: (() => void) | undefined;
  let turnTimer: ReturnType<typeof setTimeout> | undefined;
  const startedAt = Date.now();
  try {
    await fs.copy(options.sourceProjectRoot, workspaceRoot, { dereference: false });
    if (options.variant === 'without_skill') {
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
      materializeCodexEvalRuntimeHome(options.codexRuntime, codexHome),
    ]);
    const before = await snapshotWorkspace(workspaceRoot);
    await assertProcessTreeInspectionAvailable();
    assertCodexEvalCanStartWork();
    session = new EvalAppServerSession({
      codexBin: options.codexBin,
      cwd: workspaceRoot,
      env,
      modelProvider: options.codexRuntime.modelProvider,
      sensitiveEnvironmentNames: options.codexRuntime.sensitiveEnvironmentNames,
    });
    let replyStep = 0;
    let turnResolve: ((value: { complete: boolean }) => void) | undefined;
    let turnReject: ((error: Error) => void) | undefined;
    const turnDone = new Promise<{ complete: boolean }>((resolve, reject) => {
      turnResolve = resolve;
      turnReject = reject;
    });
    removeFailureHandler = session.onFailure((error) => turnReject?.(error));
    turnTimer = setTimeout(() => {
      turnReject?.(new Error(`conversation turn timed out after ${options.timeoutMs}ms.`));
    }, options.timeoutMs);

    removeHandler = session.onFrame(async (frame) => {
      eventTrace.push(frame);
      const method = typeof frame.method === 'string' ? frame.method : '';
      const params = isRecord(frame.params) ? frame.params : {};
      if (method === 'item/tool/requestUserInput') {
        const id = requestId(frame.id);
        if (!id || !Array.isArray(params.questions)) {
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
        await session!.respond(id, {
          answers: Object.fromEntries(
            Object.entries(answers).map(([key, value]) => [key, { answers: value }]),
          ),
        });
        return;
      }
      if (method === 'item/completed' && isRecord(params.item)) {
        const item = params.item;
        if (item.type === 'agentMessage' && typeof item.text === 'string') {
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
    const threadResult = await session.sendRequest('thread/start', {
      cwd: workspaceRoot,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      ephemeral: false,
      ...(options.model ? { model: options.model } : {}),
    });
    const threadId = extractThreadId(threadResult);
    await session.sendRequest('turn/start', {
      threadId,
      input: [{ type: 'text', text: options.evalCase.prompt, text_elements: [] }],
      cwd: workspaceRoot,
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'readOnly', networkAccess: true },
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
    if (replyStep < options.evalCase.scriptedReplies.length) {
      diagnostics.push(
        `${options.evalCase.scriptedReplies.length - replyStep} scripted reply step(s) were unused.`,
      );
    }
    if (options.evalCase.workspaceUnchanged && workspaceChanges.length > 0) {
      diagnostics.push(`Workspace changed: ${workspaceChanges.join(', ')}`);
    }
    return {
      variant: options.variant,
      complete: completed.complete,
      mechanicalPassed: completed.complete && diagnostics.length === 0,
      durationMs: Date.now() - startedAt,
      questions,
      finalMessages,
      usage,
      workspaceChanges,
      diagnostics,
      eventTrace,
      ...(session.stderr.trim() ? { stderr: session.stderr.trim() } : {}),
    };
  } catch (error) {
    return {
      variant: options.variant,
      complete: false,
      mechanicalPassed: false,
      durationMs: Date.now() - startedAt,
      questions,
      finalMessages,
      usage,
      workspaceChanges: [],
      diagnostics: [error instanceof Error ? error.stack ?? error.message : String(error)],
      eventTrace,
      ...(session?.stderr.trim() ? { stderr: session.stderr.trim() } : {}),
    };
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

export async function runCodexConversationSuite(options: {
  suiteId: string;
  skillName: string;
  casesPath: string;
  subjectRoot: string;
  profile: string;
  runs: number;
  caseId?: string;
  codexBin: string;
  model?: string;
  codexRuntime?: CodexEvalRuntimeConfig;
  timeoutMs: number;
  sourceEnv?: NodeJS.ProcessEnv;
  reportPath?: string;
}): Promise<PluginEvalSuiteReport> {
  const sourceEnv = options.sourceEnv ?? process.env;
  const codexRuntime = options.codexRuntime ?? cleanCodexEvalRuntimeConfig(sourceEnv, options.model);
  const model = options.model ?? codexRuntime.model ?? undefined;
  let cases = await readConversationCases(options.casesPath, options.skillName);
  if (options.caseId) {
    cases = cases.filter((entry) => entry.id === options.caseId);
    if (cases.length === 0) {
      throw new Error(`Unknown conversation case: ${options.caseId}`);
    }
  }
  const results = [];
  for (const evalCase of cases) {
    const runs = [];
    for (let runIndex = 0; runIndex < options.runs; runIndex += 1) {
      assertCodexEvalCanStartWork();
      const withSkill = await runConversationOnce({
        sourceProjectRoot: options.subjectRoot,
        evalCase,
        variant: 'with_skill',
        skillName: options.skillName,
        codexBin: options.codexBin,
        model,
        codexRuntime,
        timeoutMs: options.timeoutMs,
        sourceEnv,
      });
      assertCodexEvalCanStartWork();
      const withoutSkill = await runConversationOnce({
        sourceProjectRoot: options.subjectRoot,
        evalCase,
        variant: 'without_skill',
        skillName: options.skillName,
        codexBin: options.codexBin,
        model,
        codexRuntime,
        timeoutMs: options.timeoutMs,
        sourceEnv,
      });
      runs.push({ run: runIndex + 1, with_skill: withSkill, without_skill: withoutSkill });
    }
    results.push({
      id: evalCase.id,
      prompt: evalCase.prompt,
      expected_output: evalCase.expectedOutput,
      checks: evalCase.checks,
      runs,
    });
  }
  const allRuns = results.flatMap((entry) => entry.runs).flatMap((run) => [
    run.with_skill,
    run.without_skill,
  ]);
  const complete = allRuns.every((run) => run.complete);
  const mechanicalPassed = complete && allRuns.every((run) => run.mechanicalPassed);
  const report = redactCodexEvalValue({
    schema_version: 1,
    generated_at: new Date().toISOString(),
    suite: options.suiteId,
    profile: options.profile,
    complete,
    mechanical_passed: mechanicalPassed,
    qualitative_review: 'required',
    environment: {
      codex_runtime: codexEvalRuntimeEvidence(codexRuntime),
    },
    results,
  }, codexRuntime);
  if (options.reportPath) {
    await fs.ensureDir(path.dirname(options.reportPath));
    await fs.writeJson(options.reportPath, report, { spaces: 2 });
  }
  return redactCodexEvalValue({
    id: options.suiteId,
    kind: 'conversation',
    profile: options.profile,
    split: null,
    outcome: !complete ? 'incomplete' : !mechanicalPassed ? 'failed' : 'needs_review',
    complete,
    mechanicalPassed,
    qualitativeReview: 'required',
    ...(options.reportPath ? { reportPath: options.reportPath } : {}),
    summary: {
      cases: results.length,
      runs: allRuns.length,
    },
    diagnostics: allRuns.flatMap((run) => run.diagnostics),
  }, codexRuntime);
}
