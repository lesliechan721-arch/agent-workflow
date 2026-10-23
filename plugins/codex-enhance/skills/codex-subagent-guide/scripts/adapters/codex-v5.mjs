#!/usr/bin/env node
import { fail, LIMITS } from '../runtime/contracts.mjs';
import { adapterMain, backendLines, checkArguments, collaborationInput, communicationInstructions, deferred, rejectOption } from './common.mjs';

export function checkCodexArguments(request, owned = []) {
  checkArguments(request.args, {
    owned: ['--json', '--output-last-message', '-o', '--cd', '-C', '--worktree', '--help', '-h', '--version', '-V', ...owned],
    commands: ['exec', 'resume', 'fork', 'review', 'help'],
    short: { '-c': 'value', '-m': 'value', '-p': 'value', '-s': 'value', '-a': 'value', '-i': 'value' },
    values: ['--config', '--model', '--profile', '--sandbox', '--ask-for-approval', '--enable', '--disable', '--local-provider', '--add-dir', '--thread-source', '--cyber-access-program', '--output-schema', '--color'],
    variadic: ['--image', '-i'],
    booleans: ['--oss', '--approve-for-me', '--full-auto', '--dangerously-bypass-approvals-and-sandbox', '--dangerously-bypass-hook-trust', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--strict-config'],
    onOption(option, value) {
      const key = String(value ?? '').split('=', 1)[0].trim().replace(/^["']|["']$/g, '');
      if (request.execution.model !== undefined && (['--model', '-m'].includes(option) || ['--config', '-c'].includes(option) && key === 'model')) rejectOption(option);
      if (request.execution.reasoningEffort !== undefined && ['--config', '-c'].includes(option) && key === 'model_reasoning_effort') rejectOption(option);
    },
  });
}

/** Map only options whose app-server semantics are known. Reject before a turn. */
export function codexConfiguration(request) {
  checkCodexArguments(request);
  const argv = ['app-server'];
  const thread = { cwd: request.workspace };
  const turn = {};
  const values = new Set(['--config', '-c', '--enable', '--disable', '--model', '-m', '--sandbox', '-s', '--ask-for-approval', '-a']);
  const owned = new Set(['--json', '--output-last-message', '-o', '--cd', '-C', '--worktree', '--help', '-h', '--version', '-V', '--listen', '--stdio']);
  for (let index = 0; index < request.args.length; index++) {
    const argument = request.args[index];
    const equals = argument.indexOf('=');
    let option = equals < 0 ? argument : argument.slice(0, equals);
    let value = equals < 0 ? undefined : argument.slice(equals + 1);
    if (/^-[cmsa].+/.test(argument)) { option = argument.slice(0, 2); value = argument.slice(2); }
    if (owned.has(option)) rejectOption(option);
    if (values.has(option)) {
      value ??= request.args[++index];
      if (typeof value !== 'string') fail('adapterArgumentsInvalid', `${option} requires a value.`);
      if (option === '--config' || option === '-c') {
        const key = value.split('=', 1)[0].trim().replace(/^["']|["']$/g, '');
        if (key === 'model' && request.execution.model !== undefined || key === 'model_reasoning_effort' && request.execution.reasoningEffort !== undefined) rejectOption(option);
        // All user configuration remains in the backend's own TOML parser.
        argv.push('-c', value);
      } else if (option === '--enable' || option === '--disable') argv.push(option, value);
      else if (option === '--model' || option === '-m') {
        if (request.execution.model !== undefined) rejectOption(option);
        thread.model = value;
      } else if (option === '--sandbox' || option === '-s') thread.sandbox = value;
      else thread.approvalPolicy = value;
    } else if (option === '--strict-config') argv.push(option);
    else if (option === '--ephemeral') thread.ephemeral = true;
    else if (option === '--dangerously-bypass-approvals-and-sandbox') { thread.approvalPolicy = 'never'; thread.sandbox = 'danger-full-access'; }
    else if (option === '--full-auto') { thread.approvalPolicy = 'on-request'; thread.sandbox = 'workspace-write'; }
    else fail('parameterUnavailable', `The Codex app-server adapter cannot preserve ${option}. Use a supported config override or remove this explicit option.`);
  }
  if (request.execution.model !== undefined) thread.model = request.execution.model;
  if (request.execution.reasoningEffort !== undefined) turn.effort = request.execution.reasoningEffort;
  return { argv, thread, turn };
}

function createRpc(backend, context, onNotification) {
  const waiting = new Map();
  let next = 0;
  const lines = backendLines((value) => {
    if (Object.hasOwn(value, 'id') && !value.method) {
      const pending = waiting.get(value.id);
      if (!pending) { context.abort('backendOutputInvalid'); return; }
      waiting.delete(value.id);
      if (value.error) pending.reject(Object.assign(new Error('The backend rejected the request.'), { code: 'backendRequestRejected', rpcError: value.error }));
      else if (Object.hasOwn(value, 'result')) pending.resolve(value.result);
      else pending.reject(Object.assign(new Error('Invalid backend response.'), { code: 'backendOutputInvalid' }));
    } else if (value.method && Object.hasOwn(value, 'id')) {
      // User approvals belong to the user. There is no implicit approval from
      // parent collaboration input, and this adapter has no approval UI.
      void backend.write({ id: value.id, error: { code: -32000, message: 'The external adapter cannot answer interactive approvals or user questions.' } }).catch(() => {});
      context.abort(value.method.includes('Approval') ? 'backendApprovalRequired' : 'backendInteractionRequired');
    } else if (typeof value.method === 'string') onNotification(value.method, value.params ?? {});
    else context.abort('backendOutputInvalid');
  }, (code) => context.abort(code));
  backend.child.stdout.on('data', (chunk) => lines.push(chunk));
  backend.child.stdout.on('end', () => lines.end());
  backend.done.then(() => {
    for (const pending of waiting.values()) pending.reject(Object.assign(new Error('The backend closed before its response.'), { code: 'backendResponseUnknown' }));
    waiting.clear();
  });
  return {
    async call(method, params) {
      if (backend.exited) throw Object.assign(new Error('The backend has exited.'), { code: 'backendResponseUnknown' });
      const id = ++next;
      const pending = deferred();
      waiting.set(id, pending);
      try { await backend.write({ id, method, params }); }
      catch (error) { waiting.delete(id); pending.reject(error); throw error; }
      return pending.promise;
    },
    notify: (method, params = {}) => backend.write({ method, params }),
  };
}

export async function executeCodex(context) {
  const configuration = codexConfiguration(context.request);
  let rpc, threadId, activeTurn, model, finalText = '', terminal, initialAccepted = deferred();
  let starting = false, completeScheduled = false, failureCode;
  const terminalTurns = new Set();
  const knownTurns = new Set();
  let turnStarts = 0;
  const texts = new Map();
  const completed = deferred();
  const maybeComplete = () => {
    if (completeScheduled || !terminal || activeTurn || starting || context.signal.aborted || context.bridge?.hasPendingInput()) return;
    completeScheduled = true;
    // Allow already-readable control input and delivery continuations to run.
    setImmediate(() => {
      completeScheduled = false;
      if (activeTurn || starting || context.bridge.hasPendingInput() || context.signal.aborted) return;
      void context.beginClosing(terminal.status === 'completed' ? 'completed' : 'failed').then(() => completed.resolve()).catch(completed.reject);
    });
  };
  const startTurn = async (text) => {
    if (context.signal.aborted) return { status: 'notSubmitted', code: 'runClosed' };
    starting = true;
    const beforeStarts = turnStarts;
    try {
      const response = await rpc.call('turn/start', { threadId, input: [{ type: 'text', text }], ...configuration.turn });
      const id = response?.turn?.id;
      if (typeof id !== 'string' || !id) fail('backendOutputInvalid', 'The backend did not return a turn ID.');
      context.generationStarted = true;
      knownTurns.add(id);
      if (!terminalTurns.has(id)) activeTurn = id;
      return { status: 'submitted' };
    } catch (error) {
      if (error.rpcError && turnStarts === beforeStarts) return { status: 'notSubmitted', code: 'backendInputRejected' };
      return { status: 'unknown', code: 'backendResponseUnknown' };
    } finally { starting = false; maybeComplete(); }
  };
  const bridge = await context.createBridge(async ({ text }, { signal }) => {
    await initialAccepted.promise;
    if (signal.aborted || context.signal.aborted) return { status: 'notSubmitted', code: 'runClosed' };
    if (activeTurn) {
      try {
        await rpc.call('turn/steer', { threadId, expectedTurnId: activeTurn, input: [{ type: 'text', text: collaborationInput(text) }] });
        setImmediate(maybeComplete);
        return { status: 'submitted' };
      } catch (error) {
        // The official error explicitly establishes that steer did not submit.
        // A lost response has no such evidence and must never be retried.
        const detail = error.rpcError?.message;
        if (typeof detail !== 'string' || !/^no active turn to steer$|^expected active turn id `/.test(detail)) return { status: error.rpcError ? 'notSubmitted' : 'unknown', code: error.rpcError ? 'backendInputRejected' : 'backendResponseUnknown' };
      }
    }
    if (signal.aborted || context.signal.aborted) return { status: 'notSubmitted', code: 'runClosed' };
    const delivery = await startTurn(collaborationInput(text));
    setImmediate(maybeComplete);
    return delivery;
  });
  const server = `aw_parent_${context.request.run.id}`;
  const argv = [...configuration.argv,
    '-c', `mcp_servers.${server}.command=${JSON.stringify(bridge.mcpServer.command)}`,
    '-c', `mcp_servers.${server}.args=${JSON.stringify(bridge.mcpServer.args)}`,
    '-c', `mcp_servers.${server}.required=true`,
  ];
  const backend = await context.spawn('codex', argv);
  rpc = createRpc(backend, context, (method, params) => {
    if (params.threadId && threadId && params.threadId !== threadId) { context.abort('backendSessionMismatch'); return; }
    if (['turn/started', 'item/completed', 'turn/completed'].includes(method) && params.threadId !== threadId) { context.abort('backendSessionMismatch'); return; }
    if (method === 'turn/started' && typeof params.turn?.id === 'string') { activeTurn = params.turn.id; knownTurns.add(activeTurn); turnStarts++; context.generationStarted = true; }
    else if (method === 'item/completed' && params.item?.type === 'agentMessage') {
      const text = params.item.text;
      if (typeof text !== 'string' || Buffer.byteLength(text) > LIMITS.outputBytes) { context.abort('adapterOutputTooLarge'); return; }
      if (params.item.phase === 'final_answer' || params.item.phase == null) texts.set(params.turnId, text);
    } else if (method === 'turn/completed') {
      const turn = params.turn;
      if (!turn || typeof turn.id !== 'string' || !['completed', 'failed', 'interrupted'].includes(turn.status) || !knownTurns.has(turn.id) || terminalTurns.has(turn.id)) { context.abort('backendOutputInvalid'); return; }
      terminalTurns.add(turn.id);
      terminal = turn;
      if (activeTurn === turn.id) activeTurn = undefined;
      const message = Array.isArray(turn.items) ? turn.items.filter((item) => item.type === 'agentMessage' && (item.phase === 'final_answer' || item.phase == null)).at(-1) : undefined;
      finalText = message?.text ?? texts.get(turn.id) ?? '';
      texts.delete(turn.id);
      if (Buffer.byteLength(finalText) > LIMITS.outputBytes) { context.abort('adapterOutputTooLarge'); return; }
      if (turn.status === 'failed') failureCode = 'backendFailed';
      maybeComplete();
    }
  });
  context.onStop = async () => {
    if (threadId && activeTurn) {
      try { await rpc.call('turn/interrupt', { threadId, turnId: activeTurn }); } catch { /* Exit evidence remains necessary. */ }
    }
    await backend.end();
  };
  try {
    await rpc.call('initialize', { clientInfo: { name: 'aw-subagent', version: '5' }, capabilities: {} });
    await rpc.notify('initialized');
    const response = await rpc.call('thread/start', configuration.thread);
    threadId = response?.thread?.id;
    if (typeof threadId !== 'string' || !threadId) fail('backendOutputInvalid', 'The backend did not return a thread ID.');
    if (typeof response.model === 'string') model = response.model;
    if (context.signal.aborted) return { state: 'cancelled', code: context.errorCode, text: '' };
    await context.ready(true);
    context.generationStarted = null;
    const first = await startTurn(`${context.request.prompt}\n\n${communicationInstructions}`);
    initialAccepted.resolve();
    if (first.status !== 'submitted') {
      if (first.status === 'notSubmitted') context.generationStarted = false;
      fail(first.code, 'The backend did not confirm the initial input.');
    }
    await Promise.race([completed.promise, backend.done, context.stopped.promise, new Promise((resolve) => context.signal.addEventListener('abort', resolve, { once: true }))]);
    if (!context.signal.aborted && !backend.exited && terminal) {
      await rpc.call('thread/unsubscribe', { threadId });
      await backend.end();
    }
    await Promise.race([backend.done, context.stopped.promise]);
    const common = { text: finalText, ...(threadId ? { sessionId: threadId } : {}), ...(model ? { model } : {}) };
    if (context.signal.aborted) return { ...common, state: 'unknown', code: context.errorCode };
    if (terminal?.status === 'failed') return { ...common, state: 'failed', code: failureCode ?? 'backendFailed' };
    if (terminal?.status !== 'completed' || !finalText.trim() || backend.exitCode !== 0) return { ...common, state: 'unknown', code: 'serviceTerminalUnconfirmed' };
    return { ...common, state: 'completed' };
  } finally {
    initialAccepted.resolve();
    if (!backend.exited) await backend.end();
  }
}

adapterMain(import.meta.url, { mode: 'workspace', execute: executeCodex }, 'Codex Adapter v5\nUsage: node codex-v5.mjs\nReads one persistent v5 JSONL connection. Uses PATH codex app-server, private parent tools, and automatic input.\nNormal backend configuration and approvals apply. Unsupported explicit options fail before model submission.\nNo default execution deadline or automatic retry. Backend process exit and service terminal are required.\n');
