#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { LIMITS } from '../runtime/contracts.mjs';
import { adapterMain, backendLines, checkArguments, collaborationInput, communicationInstructions, deferred, rejectOption } from './common.mjs';

export function claudeArguments(request, mcpServer) {
  checkArguments(request.args, {
    owned: ['--print', '-p', '--output-format', '--input-format', '--continue', '-c', '--resume', '-r', '--fork-session', '--from-pr', '--cloud', '--remote', '--environment', '--teleport', '--worktree', '-w', '--tmux', '--help', '-h', '--version', '-v', '--replay-user-messages', '--permission-prompt-tool'],
    commands: ['agents', 'auth', 'doctor', 'install', 'mcp', 'plugin', 'plugins', 'setup-token', 'update', 'upgrade'],
    short: { '-d': 'value', '-n': 'value' },
    values: ['--agent', '--agents', '--append-system-prompt', '--debug-file', '--effort', '--fallback-model', '--json-schema', '--max-budget-usd', '--model', '--name', '--permission-mode', '--plugin-dir', '--remote-control-session-name-prefix', '--session-id', '--setting-sources', '--settings', '--system-prompt', '--system-prompt-file', '--append-system-prompt-file'],
    variadic: ['--add-dir', '--allowedTools', '--allowed-tools', '--disallowedTools', '--disallowed-tools', '--betas', '--file', '--mcp-config', '--tools'],
    booleans: ['--allow-dangerously-skip-permissions', '--bare', '--brief', '--chrome', '--dangerously-skip-permissions', '--disable-slash-commands', '--exclude-dynamic-system-prompt-sections', '--ide', '--include-hook-events', '--include-partial-messages', '--mcp-debug', '--no-chrome', '--no-session-persistence', '--strict-mcp-config', '--verbose'],
    onOption(option) {
      if (request.execution.model !== undefined && option === '--model') rejectOption(option);
      if (request.execution.reasoningEffort !== undefined && option === '--effort') rejectOption(option);
    },
  });
  const args = ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--replay-user-messages', ...request.args];
  if (request.execution.model !== undefined) args.push('--model', request.execution.model);
  if (request.execution.reasoningEffort !== undefined) args.push('--effort', request.execution.reasoningEffort);
  if (mcpServer) args.push('--mcp-config', JSON.stringify({ mcpServers: { [`aw_parent_${request.run.id}`]: mcpServer } }));
  return args;
}

export async function executeClaude(context) {
  // Validate explicit options before allocating communication resources.
  claudeArguments(context.request);
  let backend, active = false, terminal, text = '', sessionId, model, scheduled = false;
  let firstSent = false;
  const settled = deferred();
  const acknowledgements = new Map();
  const maybeComplete = () => {
    if (scheduled) return;
    scheduled = true;
    setImmediate(() => {
      scheduled = false;
      if (!terminal || active || context.signal.aborted || context.bridge.hasPendingInput()) return;
      void context.beginClosing(terminal.subtype === 'success' && !terminal.is_error ? 'completed' : 'failed').then(() => settled.resolve()).catch(settled.reject);
    });
  };
  const sendInput = async (input, signal) => {
    if (signal?.aborted || context.signal.aborted) return { status: 'notSubmitted', code: 'runClosed' };
    const uuid = randomUUID();
    const acknowledgement = deferred();
    acknowledgements.set(uuid, acknowledgement);
    active = true;
    terminal = undefined;
    try {
      await backend.write({ type: 'user', uuid, session_id: sessionId ?? '', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'text', text: input }] } });
      return await acknowledgement.promise;
    } catch {
      return { status: 'unknown', code: 'backendResponseUnknown' };
    } finally { acknowledgements.delete(uuid); maybeComplete(); }
  };
  // Leave input unassigned while a turn can still call receive_parent.
  // A verified result is required before automatic input starts a new turn.
  const bridge = await context.createBridge(async ({ text: input }, { signal }) => {
    if (signal.aborted || context.signal.aborted) return { status: 'notSubmitted', code: 'runClosed' };
    return sendInput(collaborationInput(input), signal);
  }, () => firstSent && !active && terminal !== undefined && !context.signal.aborted);
  backend = await context.spawn('claude', claudeArguments(context.request, bridge.mcpServer));
  const lines = backendLines((value) => {
    if (value.type === 'system' && value.subtype === 'init') {
      if (typeof value.session_id === 'string') sessionId = value.session_id;
      if (typeof value.model === 'string') model = value.model;
    } else if (value.type === 'user' && acknowledgements.has(value.uuid)) {
      acknowledgements.get(value.uuid).resolve({ status: 'submitted' });
    } else if (value.type === 'assistant') context.generationStarted = true;
    else if (value.type === 'result') {
      if (typeof value.is_error !== 'boolean' || !Number.isSafeInteger(value.num_turns) || value.num_turns < 0 || typeof value.session_id !== 'string' || !value.session_id || typeof value.subtype !== 'string' || terminal && !active) { context.abort('backendOutputInvalid'); return; }
      if (sessionId && sessionId !== value.session_id) { context.abort('backendSessionMismatch'); return; }
      sessionId = value.session_id;
      terminal = value;
      active = false;
      if (value.num_turns > 0) context.generationStarted = true;
      text = typeof value.result === 'string' ? value.result : '';
      if (Buffer.byteLength(text) > LIMITS.outputBytes) { context.abort('adapterOutputTooLarge'); return; }
      maybeComplete();
    } else if (value.type === 'control_request') {
      // Preserve the user's permission policy; never grant permission here.
      context.abort('backendApprovalRequired');
    }
  }, (code) => context.abort(code));
  backend.child.stdout.on('data', (chunk) => lines.push(chunk));
  backend.child.stdout.on('end', () => lines.end());
  backend.done.then(() => {
    for (const pending of acknowledgements.values()) pending.resolve({ status: 'unknown', code: 'backendResponseUnknown' });
  });
  context.onStop = async () => {
    try { await backend.write({ type: 'control_request', request_id: randomUUID(), request: { subtype: 'interrupt' } }); } catch { /* Actual exit is still required. */ }
    await backend.end();
  };
  await context.ready(true);
  if (context.signal.aborted) return { state: 'cancelled', code: context.errorCode, text: '' };
  context.generationStarted = null;
  // Initial prompt acceptance is not a parent delivery, but keep its rejection
  // observable. The readiness gate also prevents input before this first turn.
  const initial = sendInput(`${context.request.prompt}\n\n${communicationInstructions}`);
  firstSent = true;
  void initial.then((delivery) => { if (delivery.status !== 'submitted' && !terminal) context.abort(delivery.code); });
  await Promise.race([settled.promise, backend.done, context.stopped.promise, new Promise((resolve) => context.signal.addEventListener('abort', resolve, { once: true }))]);
  if (!backend.exited) await backend.end();
  await Promise.race([backend.done, context.stopped.promise]);
  const common = { text, ...(sessionId ? { sessionId } : {}), ...(model ? { model } : {}) };
  if (context.signal.aborted) return { ...common, state: 'unknown', code: context.errorCode };
  if (!terminal) return { ...common, state: 'unknown', code: 'serviceTerminalUnconfirmed' };
  if (terminal.is_error === true && terminal.subtype.startsWith('error_')) return { ...common, state: 'failed', code: 'backendFailed' };
  if (terminal.subtype !== 'success' || terminal.is_error || terminal.num_turns < 1 || backend.exitCode !== 0 || !text.trim()) return { ...common, state: 'unknown', code: 'serviceTerminalConflict' };
  return { ...common, state: 'completed' };
}

adapterMain(import.meta.url, { mode: 'workspace', execute: executeClaude }, 'Claude Code Adapter v5\nUsage: node claude-code-v5.mjs\nReads one persistent v5 JSONL connection. Uses PATH claude with streaming input, private parent MCP tools, and service results.\nNormal configuration and permissions apply. No implicit approval, default execution deadline, or automatic retry.\n');
