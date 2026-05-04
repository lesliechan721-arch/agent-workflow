import { spawn } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

export interface CodexAppServerInvocation {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface CodexAppServerProcess {
  stdin: Writable | null;
  stdout: Readable | null;
  stderr: Readable | null;
  pid?: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: 'error', listener: (error: Error) => void): this;
  on(
    event: 'close',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  once(event: 'error', listener: (error: Error) => void): this;
  once(
    event: 'close',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
}

export type CodexAppServerProcessRunner = (
  invocation: CodexAppServerInvocation,
) => CodexAppServerProcess;

export interface CodexAppServerBaseOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
  runner?: CodexAppServerProcessRunner;
  clientName?: string;
  clientVersion?: string;
}

export interface InstallCodexPluginViaAppServerOptions
  extends CodexAppServerBaseOptions {
  marketplacePath: string;
  pluginName: string;
}

export interface UninstallCodexPluginViaAppServerOptions
  extends CodexAppServerBaseOptions {
  pluginId: string;
}

export interface CodexAppServerCallResult<TResult = unknown> {
  method: 'plugin/install' | 'plugin/uninstall';
  requestId: string;
  result: TResult;
  stderr: string;
}

export type CodexAppServerErrorCategory =
  | 'spawn_failure'
  | 'timeout'
  | 'protocol_error'
  | 'early_exit'
  | 'method_unavailable'
  | 'invalid_request'
  | 'plugins_disabled'
  | 'install_policy_denied'
  | 'request_rejected';

export interface CodexAppServerErrorContext {
  command: string;
  args: string[];
  cwd?: string;
  pid?: number;
  method: string;
  requestId?: string;
  marketplacePath?: string;
  pluginName?: string;
  pluginId?: string;
  stderr?: string;
  rawLine?: string;
  rpcCode?: number;
  rpcMessage?: string;
  timeoutMs?: number;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  causeMessage?: string;
}

export class CodexAppServerError extends Error {
  readonly category: CodexAppServerErrorCategory;
  readonly suggestion: string;
  readonly debugContext: CodexAppServerErrorContext;

  constructor(options: {
    category: CodexAppServerErrorCategory;
    summary: string;
    suggestion: string;
    debugContext: CodexAppServerErrorContext;
  }) {
    super(
      `${options.summary}${options.suggestion ? ` ${options.suggestion}` : ''}${renderDebugContext(options.debugContext)}`,
    );
    this.name = 'CodexAppServerError';
    this.category = options.category;
    this.suggestion = options.suggestion;
    this.debugContext = options.debugContext;
  }
}

interface PendingRequest {
  id: string;
  method: string;
  timer: ReturnType<typeof setTimeout>;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface RpcErrorPayload {
  code?: number;
  message: string;
}

const DEFAULT_TIMEOUT_MS = 15_000;

function defaultCodexAppServerProcessRunner(
  invocation: CodexAppServerInvocation,
): CodexAppServerProcess {
  return spawn(invocation.command, invocation.args, {
    cwd: invocation.cwd,
    env: invocation.env,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as unknown as CodexAppServerProcess;
}

function describeOperation(method: string): '安装' | '卸载' {
  return method === 'plugin/uninstall' ? '卸载' : '安装';
}

function describeFallbackGuard(method: string): string {
  return method === 'plugin/uninstall'
    ? 'AW 不会回退到只删 `config.toml`。'
    : 'AW 不会回退到只写 `config.toml`。';
}

function sanitizeDebugValue(value: unknown): string {
  if (value === undefined) {
    return '';
  }
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'string') {
    return JSON.stringify(value.length > 240 ? `${value.slice(0, 240)}...` : value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify(String(value));
  }
}

function renderDebugContext(context: CodexAppServerErrorContext): string {
  const entries = Object.entries(context)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${sanitizeDebugValue(value)}`);
  return entries.length > 0 ? ` Debug: ${entries.join(', ')}` : '';
}

function createCodexAppServerError(options: {
  category: CodexAppServerErrorCategory;
  method: string;
  requestId?: string;
  invocation: CodexAppServerInvocation;
  stderr?: string;
  marketplacePath?: string;
  pluginName?: string;
  pluginId?: string;
  rpcCode?: number;
  rpcMessage?: string;
  rawLine?: string;
  timeoutMs?: number;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  cause?: unknown;
  pid?: number;
}): CodexAppServerError {
  const operation = describeOperation(options.method);
  const debugContext: CodexAppServerErrorContext = {
    command: options.invocation.command,
    args: options.invocation.args,
    cwd: options.invocation.cwd,
    pid: options.pid,
    method: options.method,
    requestId: options.requestId,
    marketplacePath: options.marketplacePath,
    pluginName: options.pluginName,
    pluginId: options.pluginId,
    stderr: options.stderr?.trim() || undefined,
    rawLine: options.rawLine,
    rpcCode: options.rpcCode,
    rpcMessage: options.rpcMessage,
    timeoutMs: options.timeoutMs,
    exitCode: options.exitCode,
    signal: options.signal,
    causeMessage: options.cause instanceof Error ? options.cause.message : undefined,
  };

  if (options.category === 'spawn_failure') {
    return new CodexAppServerError({
      category: options.category,
      summary: `无法启动 \`codex app-server\`，AW 没有完成 Codex 原生插件${operation}。`,
      suggestion: `请确认 Codex CLI 已安装，并升级到支持 app-server 插件 RPC 的版本后重试。${describeFallbackGuard(options.method)}`,
      debugContext,
    });
  }

  if (options.category === 'timeout') {
    return new CodexAppServerError({
      category: options.category,
      summary: `等待 Codex app-server 响应 \`${options.method}\` 超时，AW 没有确认 Codex 原生插件${operation}已完成。`,
      suggestion: `请重试；如果仍失败，请先手动运行 \`codex app-server\` 检查环境。${describeFallbackGuard(options.method)}`,
      debugContext,
    });
  }

  if (options.category === 'protocol_error') {
    return new CodexAppServerError({
      category: options.category,
      summary: `Codex app-server 返回了无法解析的输出，AW 无法确认 Codex 原生插件${operation}是否成功。`,
      suggestion: `请升级 Codex CLI 或查看 debug log 排查协议输出。${describeFallbackGuard(options.method)}`,
      debugContext,
    });
  }

  if (options.category === 'early_exit') {
    return new CodexAppServerError({
      category: options.category,
      summary: `Codex app-server 在返回 \`${options.method}\` 响应前提前退出，AW 没有完成 Codex 原生插件${operation}。`,
      suggestion: `请先手动运行 \`codex app-server\` 查看退出原因，或升级 Codex CLI 后重试。${describeFallbackGuard(options.method)}`,
      debugContext,
    });
  }

  if (options.category === 'method_unavailable') {
    return new CodexAppServerError({
      category: options.category,
      summary: `当前 Codex app-server 不支持 \`${options.method}\`。`,
      suggestion: `请升级 Codex CLI 到支持插件 RPC 的版本后重试。${describeFallbackGuard(options.method)}`,
      debugContext,
    });
  }

  if (options.category === 'invalid_request') {
    return new CodexAppServerError({
      category: options.category,
      summary: `Codex app-server 对 \`${options.method}\` 返回了 invalid request，当前协议与 AW 期望不兼容。`,
      suggestion: `请升级 Codex CLI 到支持当前 app-server 协议的版本后重试。${describeFallbackGuard(options.method)}`,
      debugContext,
    });
  }

  if (options.category === 'plugins_disabled') {
    return new CodexAppServerError({
      category: options.category,
      summary: `Codex plugins 功能在当前 workspace 被禁用，AW 无法完成 Codex 原生插件${operation}。`,
      suggestion: `请先在 Codex 中启用 plugins feature 后重试。${describeFallbackGuard(options.method)}`,
      debugContext,
    });
  }

  if (options.category === 'install_policy_denied') {
    return new CodexAppServerError({
      category: options.category,
      summary: `Codex 拒绝通过 \`${options.method}\` 处理该插件，当前 install policy 不允许这次${operation}。`,
      suggestion: `请检查插件 policy、workspace 限制或改用允许安装的环境后重试。${describeFallbackGuard(options.method)}`,
      debugContext,
    });
  }

  return new CodexAppServerError({
    category: options.category,
    summary: `Codex app-server 拒绝了 \`${options.method}\` 请求，AW 没有完成 Codex 原生插件${operation}。`,
    suggestion: `请先手动运行 \`codex app-server\` 或升级 Codex CLI 排查，再重试。${describeFallbackGuard(options.method)}`,
    debugContext,
  });
}

function normalizeRpcErrorPayload(value: unknown): RpcErrorPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { message: typeof value === 'string' ? value : 'unknown rpc error' };
  }
  const candidate = value as { code?: unknown; message?: unknown };
  return {
    code: typeof candidate.code === 'number' ? candidate.code : undefined,
    message:
      typeof candidate.message === 'string'
        ? candidate.message
        : JSON.stringify(value),
  };
}

function classifyRpcError(error: RpcErrorPayload): CodexAppServerErrorCategory {
  const message = error.message.toLowerCase();

  if (error.code === -32601 || message.includes('unknown method') || message.includes('method not found')) {
    return 'method_unavailable';
  }
  if (error.code === -32600 || message.includes('invalid request')) {
    return 'invalid_request';
  }
  if (message.includes('plugins are disabled for this workspace')) {
    return 'plugins_disabled';
  }
  if (
    message.includes('install policy') ||
    message.includes('installation policy') ||
    (message.includes('policy') &&
      (message.includes('denied') || message.includes('refused') || message.includes('not allowed')))
  ) {
    return 'install_policy_denied';
  }
  return 'request_rejected';
}

function isResponseFrame(frame: Record<string, unknown>): boolean {
  return 'id' in frame && ('result' in frame || 'error' in frame);
}

class CodexAppServerSession {
  private readonly invocation: CodexAppServerInvocation;
  private readonly process: CodexAppServerProcess;
  private readonly timeoutMs: number;
  private readonly operationContext: {
    marketplacePath?: string;
    pluginName?: string;
    pluginId?: string;
  };
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly closePromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  private readonly closePromiseResolve: (
    value: { code: number | null; signal: NodeJS.Signals | null },
  ) => void;

  private stdoutBuffer = '';
  private stderrBuffer = '';
  private closed = false;
  private cleaningUp = false;
  private terminalError?: Error;

  constructor(options: {
    invocation: CodexAppServerInvocation;
    timeoutMs: number;
    runner: CodexAppServerProcessRunner;
    operationContext: {
      marketplacePath?: string;
      pluginName?: string;
      pluginId?: string;
    };
  }) {
    this.invocation = options.invocation;
    this.timeoutMs = options.timeoutMs;
    this.operationContext = options.operationContext;
    let resolveClose:
      | ((value: { code: number | null; signal: NodeJS.Signals | null }) => void)
      | undefined;
    this.closePromise = new Promise((resolve) => {
      resolveClose = resolve;
    });
    this.closePromiseResolve = resolveClose!;

    try {
      this.process = options.runner(this.invocation);
    } catch (error) {
      throw createCodexAppServerError({
        category: 'spawn_failure',
        method: 'initialize',
        invocation: this.invocation,
        marketplacePath: this.operationContext.marketplacePath,
        pluginName: this.operationContext.pluginName,
        pluginId: this.operationContext.pluginId,
        cause: error,
      });
    }

    if (!this.process.stdin || !this.process.stdout || !this.process.stderr) {
      throw createCodexAppServerError({
        category: 'spawn_failure',
        method: 'initialize',
        invocation: this.invocation,
        marketplacePath: this.operationContext.marketplacePath,
        pluginName: this.operationContext.pluginName,
        pluginId: this.operationContext.pluginId,
        cause: new Error('codex app-server stdio is unavailable'),
        pid: this.process.pid,
      });
    }

    this.process.stdout.setEncoding?.('utf8');
    this.process.stderr.setEncoding?.('utf8');
    this.process.stdout.on('data', (chunk: string | Buffer) => {
      this.handleStdoutChunk(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    });
    this.process.stderr.on('data', (chunk: string | Buffer) => {
      this.stderrBuffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    });
    this.process.on('error', (error) => {
      this.failAll(
        createCodexAppServerError({
          category: 'spawn_failure',
          method: this.firstPendingMethod() ?? 'initialize',
          requestId: this.firstPendingRequestId(),
          invocation: this.invocation,
          stderr: this.stderrBuffer,
          marketplacePath: this.operationContext.marketplacePath,
          pluginName: this.operationContext.pluginName,
          pluginId: this.operationContext.pluginId,
          cause: error,
          pid: this.process.pid,
        }),
      );
    });
    this.process.on('close', (code, signal) => {
      this.closed = true;
      this.closePromiseResolve({ code, signal });
      if (this.cleaningUp || this.pendingRequests.size === 0) {
        return;
      }
      this.failAll(
        createCodexAppServerError({
          category: 'early_exit',
          method: this.firstPendingMethod() ?? 'initialize',
          requestId: this.firstPendingRequestId(),
          invocation: this.invocation,
          stderr: this.stderrBuffer,
          marketplacePath: this.operationContext.marketplacePath,
          pluginName: this.operationContext.pluginName,
          pluginId: this.operationContext.pluginId,
          exitCode: code,
          signal,
          pid: this.process.pid,
        }),
      );
    });
  }

  async initialize(clientName: string, clientVersion: string): Promise<void> {
    await this.sendRequest('init-1', 'initialize', {
      clientInfo: {
        name: clientName,
        version: clientVersion,
      },
      capabilities: {},
    });
    await this.sendNotification('initialized');
  }

  async sendRequest<TParams>(
    id: string,
    method: string,
    params: TParams,
  ): Promise<unknown> {
    if (this.terminalError) {
      throw this.terminalError;
    }
    await this.writeFrame({ id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(
          createCodexAppServerError({
            category: 'timeout',
            method,
            requestId: id,
            invocation: this.invocation,
            stderr: this.stderrBuffer,
            marketplacePath: this.operationContext.marketplacePath,
            pluginName: this.operationContext.pluginName,
            pluginId: this.operationContext.pluginId,
            timeoutMs: this.timeoutMs,
            pid: this.process.pid,
          }),
        );
      }, this.timeoutMs);
      this.pendingRequests.set(id, {
        id,
        method,
        timer,
        resolve,
        reject,
      });
    });
  }

  async sendNotification<TParams extends Record<string, unknown> | undefined>(
    method: string,
    params?: TParams,
  ): Promise<void> {
    const frame = params === undefined ? { method } : { method, params };
    await this.writeFrame(frame);
  }

  async cleanup(): Promise<void> {
    this.cleaningUp = true;
    this.failAllSilently();
    if (!this.closed) {
      this.process.kill('SIGTERM');
      await Promise.race([
        this.closePromise,
        new Promise((resolve) => setTimeout(resolve, 250)),
      ]);
    }
  }

  private async writeFrame(frame: Record<string, unknown>): Promise<void> {
    if (!this.process.stdin) {
      throw createCodexAppServerError({
        category: 'spawn_failure',
        method: 'initialize',
        invocation: this.invocation,
        stderr: this.stderrBuffer,
        marketplacePath: this.operationContext.marketplacePath,
        pluginName: this.operationContext.pluginName,
        pluginId: this.operationContext.pluginId,
        cause: new Error('codex app-server stdin is unavailable'),
        pid: this.process.pid,
      });
    }
    await new Promise<void>((resolve, reject) => {
      this.process.stdin!.write(`${JSON.stringify(frame)}\n`, (error) => {
        if (error) {
          reject(
            createCodexAppServerError({
              category: 'early_exit',
              method: typeof frame.method === 'string' ? frame.method : 'initialize',
              requestId: typeof frame.id === 'string' ? frame.id : undefined,
              invocation: this.invocation,
              stderr: this.stderrBuffer,
              marketplacePath: this.operationContext.marketplacePath,
              pluginName: this.operationContext.pluginName,
              pluginId: this.operationContext.pluginId,
              cause: error,
              exitCode: this.process.exitCode,
              signal: this.process.signalCode,
              pid: this.process.pid,
            }),
          );
          return;
        }
        resolve();
      });
    });
  }

  private handleStdoutChunk(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newlineIndex = this.stdoutBuffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const rawLine = this.stdoutBuffer.slice(0, newlineIndex).replace(/\r$/, '');
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      this.handleStdoutLine(rawLine);
      newlineIndex = this.stdoutBuffer.indexOf('\n');
    }
  }

  private handleStdoutLine(rawLine: string): void {
    if (rawLine.trim() === '') {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawLine);
    } catch {
      this.failAll(
        createCodexAppServerError({
          category: 'protocol_error',
          method: this.firstPendingMethod() ?? 'initialize',
          requestId: this.firstPendingRequestId(),
          invocation: this.invocation,
          stderr: this.stderrBuffer,
          marketplacePath: this.operationContext.marketplacePath,
          pluginName: this.operationContext.pluginName,
          pluginId: this.operationContext.pluginId,
          rawLine,
          pid: this.process.pid,
        }),
      );
      return;
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      this.failAll(
        createCodexAppServerError({
          category: 'protocol_error',
          method: this.firstPendingMethod() ?? 'initialize',
          requestId: this.firstPendingRequestId(),
          invocation: this.invocation,
          stderr: this.stderrBuffer,
          marketplacePath: this.operationContext.marketplacePath,
          pluginName: this.operationContext.pluginName,
          pluginId: this.operationContext.pluginId,
          rawLine,
          pid: this.process.pid,
        }),
      );
      return;
    }

    const frame = parsed as Record<string, unknown>;
    if (!isResponseFrame(frame)) {
      return;
    }

    const id = typeof frame.id === 'string' ? frame.id : typeof frame.id === 'number' ? String(frame.id) : undefined;
    if (!id) {
      return;
    }
    const pending = this.pendingRequests.get(id);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    this.pendingRequests.delete(id);

    if ('error' in frame) {
      const rpcError = normalizeRpcErrorPayload(frame.error);
      pending.reject(
        createCodexAppServerError({
          category: classifyRpcError(rpcError),
          method: pending.method,
          requestId: pending.id,
          invocation: this.invocation,
          stderr: this.stderrBuffer,
          marketplacePath: this.operationContext.marketplacePath,
          pluginName: this.operationContext.pluginName,
          pluginId: this.operationContext.pluginId,
          rpcCode: rpcError.code,
          rpcMessage: rpcError.message,
          pid: this.process.pid,
        }),
      );
      return;
    }

    pending.resolve(frame.result);
  }

  private failAll(error: Error): void {
    if (this.terminalError) {
      return;
    }
    this.terminalError = error;
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  private failAllSilently(): void {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
    }
    this.pendingRequests.clear();
  }

  private firstPendingMethod(): string | undefined {
    return this.pendingRequests.values().next().value?.method;
  }

  private firstPendingRequestId(): string | undefined {
    return this.pendingRequests.values().next().value?.id;
  }

  get stderr(): string {
    return this.stderrBuffer;
  }
}

async function runCodexAppServerOperation<TParams>(options: {
  method: 'plugin/install' | 'plugin/uninstall';
  requestId: string;
  params: TParams;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
  runner?: CodexAppServerProcessRunner;
  clientName?: string;
  clientVersion?: string;
  marketplacePath?: string;
  pluginName?: string;
  pluginId?: string;
}): Promise<CodexAppServerCallResult> {
  const invocation: CodexAppServerInvocation = {
    command: 'codex',
    args: ['app-server'],
    cwd: options.cwd,
    env: options.env,
  };
  const session = new CodexAppServerSession({
    invocation,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    runner: options.runner ?? defaultCodexAppServerProcessRunner,
    operationContext: {
      marketplacePath: options.marketplacePath,
      pluginName: options.pluginName,
      pluginId: options.pluginId,
    },
  });

  try {
    await session.initialize(options.clientName ?? 'aw', options.clientVersion ?? '0.0.0');
    const result = await session.sendRequest(options.requestId, options.method, options.params);
    return {
      method: options.method,
      requestId: options.requestId,
      result,
      stderr: session.stderr,
    };
  } finally {
    await session.cleanup();
  }
}

export async function installCodexPluginViaAppServer(
  options: InstallCodexPluginViaAppServerOptions,
): Promise<CodexAppServerCallResult> {
  return runCodexAppServerOperation({
    method: 'plugin/install',
    requestId: 'install-1',
    params: {
      marketplacePath: options.marketplacePath,
      pluginName: options.pluginName,
    },
    cwd: options.cwd,
    env: options.env,
    timeoutMs: options.timeoutMs,
    runner: options.runner,
    clientName: options.clientName,
    clientVersion: options.clientVersion,
    marketplacePath: options.marketplacePath,
    pluginName: options.pluginName,
  });
}

export async function uninstallCodexPluginViaAppServer(
  options: UninstallCodexPluginViaAppServerOptions,
): Promise<CodexAppServerCallResult> {
  return runCodexAppServerOperation({
    method: 'plugin/uninstall',
    requestId: 'uninstall-1',
    params: {
      pluginId: options.pluginId,
    },
    cwd: options.cwd,
    env: options.env,
    timeoutMs: options.timeoutMs,
    runner: options.runner,
    clientName: options.clientName,
    clientVersion: options.clientVersion,
    pluginId: options.pluginId,
  });
}
