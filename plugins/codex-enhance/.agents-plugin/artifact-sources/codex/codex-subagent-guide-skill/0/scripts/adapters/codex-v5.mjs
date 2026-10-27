#!/usr/bin/env node
import { fail, LIMITS } from '../runtime/contracts.mjs';
import { mapHookState } from './codex-hooks.mjs';
import { resolveCodexExecutable } from './codex-executable.mjs';
import { adapterMain, backendLines, checkArguments, collaborationInput, deferred, rejectOption } from './common.mjs';
import { permissionMode, watchPermissionFallback } from './permission-mode.mjs';

export function checkCodexArguments(request, owned = []) {
  const mode = permissionMode(request);
  checkArguments(request.args, {
    owned: ['--json', '--output-last-message', '-o', '--cd', '-C', '--worktree', '--help', '-h', '--version', '-V', ...owned],
    commands: ['exec', 'resume', 'fork', 'review', 'help'],
    short: { '-c': 'value', '-m': 'value', '-p': 'value', '-s': 'value', '-a': 'value', '-i': 'value' },
    values: ['--config', '--model', '--profile', '--sandbox', '--ask-for-approval', '--enable', '--disable', '--local-provider', '--add-dir', '--thread-source', '--cyber-access-program', '--output-schema', '--color'],
    variadic: ['--image', '-i'],
    booleans: ['--oss', '--approve-for-me', '--full-auto', '--dangerously-bypass-approvals-and-sandbox', '--dangerously-bypass-hook-trust', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--strict-config'],
    onOption(option, value) {
      const key = String(value ?? '').split('=', 1)[0].trim().replace(/^["']|["']$/g, '');
      if (mode !== 'default' && (['--ask-for-approval', '-a', '--approve-for-me', '--full-auto', '--dangerously-bypass-approvals-and-sandbox'].includes(option) || ['--config', '-c'].includes(option) && ['approval_policy', 'approvals_reviewer'].some((leaf) => key === leaf || key.startsWith(`${leaf}.`)) || mode === 'full-access' && (['--sandbox', '-s'].includes(option) || ['--config', '-c'].includes(option) && (key === 'sandbox_mode' || key.startsWith('sandbox_mode.'))))) rejectOption(option);
      if (request.execution.model !== undefined && (['--model', '-m'].includes(option) || ['--config', '-c'].includes(option) && key === 'model')) rejectOption(option);
      if (request.execution.reasoningEffort !== undefined && ['--config', '-c'].includes(option) && key === 'model_reasoning_effort') rejectOption(option);
    },
  });
}

/** Profile and explicit options are merged once before choosing their phase. */
export async function codexConfiguration(request, environment = process.env, diagnostics = []) {
  checkCodexArguments(request);
  if (!request.codex || !['auto', 'cli', 'app'].includes(request.codex.cliSource) || typeof request.codex.bypassHookTrust !== 'boolean') fail('adapterProtocolInvalid', 'Codex requires an explicit CLI source and hook bypass setting.');
  const { readCodexProfile, convertProfile, parseConfigArgument, mergeConfiguration, splitConfiguration, launchArguments } = await import('./codex-profile.mjs');
  let profile = request.codex.profile;
  let raw = Object.create(null);
  const thread = { cwd: request.workspace };
  const turn = {};
  const extras = [];
  const values = new Set(['--config', '-c', '--enable', '--disable', '--model', '-m', '--sandbox', '-s', '--ask-for-approval', '-a', '--profile', '-p']);
  for (let index = 0; index < request.args.length; index++) {
    const argument = request.args[index];
    const equals = argument.indexOf('=');
    let option = equals < 0 ? argument : argument.slice(0, equals);
    let value = equals < 0 ? undefined : argument.slice(equals + 1);
    if (/^-[cmpsa].+/.test(argument)) { option = argument.slice(0, 2); value = argument.slice(2); }
    if (values.has(option)) {
      value ??= request.args[++index];
      if (typeof value !== 'string') fail('adapterArgumentsInvalid', 'The backend option requires a value.');
      if (option === '--profile' || option === '-p') {
        if (profile !== undefined) rejectOption(option);
        profile = value;
      } else if (option === '--config' || option === '-c') {
        const parsed = parseConfigArgument(value);
        if (permissionMode(request) !== 'default' && (Object.hasOwn(parsed, 'approval_policy') || Object.hasOwn(parsed, 'approvals_reviewer') || permissionMode(request) === 'full-access' && Object.hasOwn(parsed, 'sandbox_mode'))) rejectOption(option);
        if (Object.hasOwn(parsed, 'bypass_hook_trust')) fail('parameterUnavailable', 'Use the executor codexBypassHookTrust field.');
        if (Object.hasOwn(parsed, 'model') && request.execution.model !== undefined || Object.hasOwn(parsed, 'model_reasoning_effort') && request.execution.reasoningEffort !== undefined) rejectOption(option);
        raw = mergeConfiguration(raw, parsed);
      } else if (option === '--enable' || option === '--disable') raw = mergeConfiguration(raw, { features: { [value]: option === '--enable' } });
      else if (option === '--model' || option === '-m') raw.model = value;
      else if (option === '--sandbox' || option === '-s') raw.sandbox_mode = value;
      else raw.approval_policy = value;
    } else if (option === '--strict-config') extras.push(option);
    else if (option === '--ephemeral') thread.ephemeral = true;
    else if (option === '--dangerously-bypass-approvals-and-sandbox') { raw.approval_policy = 'never'; raw.sandbox_mode = 'danger-full-access'; }
    else if (option === '--full-auto') { raw.approval_policy = 'on-request'; raw.sandbox_mode = 'workspace-write'; }
    else fail('parameterUnavailable', `The Codex app-server adapter cannot preserve ${option}. Remove this explicit option.`);
  }
  const loaded = await readCodexProfile(profile, environment, diagnostics, request.workspace);
  const defaults = convertProfile(loaded.document ?? {}, { diagnostics });
  const explicit = convertProfile(raw, { diagnostics, explicit: true });
  const merged = mergeConfiguration(defaults, explicit);
  if (permissionMode(request) === 'auto') { merged.approval_policy = 'on-request'; merged.approvals_reviewer = 'auto_review'; }
  else if (permissionMode(request) === 'full-access') { merged.approval_policy = 'never'; merged.sandbox_mode = 'danger-full-access'; }
  if (request.execution.model !== undefined) merged.model = request.execution.model;
  if (request.execution.reasoningEffort !== undefined) {
    merged.model_reasoning_effort = request.execution.reasoningEffort;
    turn.effort = request.execution.reasoningEffort;
  }
  const split = splitConfiguration(merged);
  thread.config = { ...split.thread, bypass_hook_trust: request.codex.bypassHookTrust };
  if (request.codex.bypassHookTrust) diagnostics.push({ code: 'hookTrustBypassed', field: 'codexBypassHookTrust', message: 'Hook trust is bypassed for this thread, including other native hook sources. Disabled hooks and managed restrictions remain in force.' });
  const server = `aw_parent_${request.run.id}`;
  if (Object.hasOwn(thread.config.mcp_servers ?? {}, server)) fail('adapterArgumentsInvalid', 'The private AW MCP server is owned by the adapter.');
  return { argv: launchArguments(split.launch, extras), thread, turn, profilePath: loaded.profilePath, profileHooks: defaults.hooks, rawHooks: explicit.hooks };
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
  const configuration = await codexConfiguration(context.request, context.environment, context.diagnostics);
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
      if (activeTurn || starting || context.bridge?.hasPendingInput() || context.signal.aborted) return;
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
  const server = `aw_parent_${context.request.run.id}`;
  const bridge = await context.prepareCommunication({ instructionBindings: { sendTool: `mcp__${server}__send_parent`, receiveTool: `mcp__${server}__receive_parent` }, submitInput: async ({ text }, { signal }) => {
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
  } });
  if (bridge) configuration.thread.config.mcp_servers = {
    ...configuration.thread.config.mcp_servers,
    [server]: { command: bridge.mcpServer.command, args: bridge.mcpServer.args, required: true },
  };
  const executable = context.executable;
  watchPermissionFallback(context);
  const backend = await context.spawn(executable.command, [...(executable.args ?? []), ...configuration.argv]);
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
    if (configuration.thread.config.hooks) {
      let layers;
      try { layers = await rpc.call('config/read', { cwd: context.request.workspace, includeLayers: true }); }
      catch { fail('profileHookStateUnavailable', 'The backend could not return raw hook state layers.'); }
      mapHookState(configuration, layers);
    }
    const response = await rpc.call('thread/start', configuration.thread);
    threadId = response?.thread?.id;
    if (typeof threadId !== 'string' || !threadId) fail('backendOutputInvalid', 'The backend did not return a thread ID.');
    if (typeof response.model === 'string') model = response.model;
    if (context.signal.aborted) return { state: 'cancelled', code: context.errorCode, text: '' };
    await context.ready();
    context.generationStarted = null;
    const first = await startTurn(context.prompt);
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

export async function negotiateCodexCommunication() { return { supported: true, transport: 'mcp', passiveDelivery: 'in-turn', activeReceive: true }; }

export async function negotiateCodex(context) {
  checkCodexArguments(context.request);
  if (!context.request.codex || !['auto', 'cli', 'app'].includes(context.request.codex.cliSource) || typeof context.request.codex.bypassHookTrust !== 'boolean') fail('adapterProtocolInvalid', 'Codex requires an explicit CLI source and hook bypass setting.');
  let executable;
  try { executable = await resolveCodexExecutable({ source: context.request.codex.cliSource, environment: context.environment, cwd: context.request.workspace }); }
  catch (error) {
    if (error.diagnostic) context.diagnostics.push(error.diagnostic);
    context.initialization = { environment: { status: 'unavailable', code: error.code ?? 'codexExecutableInvalid' }, capabilities: {} };
    throw error;
  }
  context.initialization = { environment: { status: 'available' }, capabilities: {} };
  if (executable.diagnostic) context.diagnostics.push(executable.diagnostic);
  const { diagnostic: _diagnostic, ...invocation } = executable;
  return { environment: { status: 'available' }, executable: invocation, capabilities: { communication: { supported: true, transport: 'mcp', passiveDelivery: 'in-turn', activeReceive: true } } };
}

adapterMain(import.meta.url, { mode: 'workspace', codex: true, permissionMode: true, negotiate: negotiateCodex, execute: executeCodex }, 'Codex Adapter v5\nUsage: node codex-v5.mjs\nReads one persistent v5 JSONL connection. Uses PATH codex app-server, private parent tools, and automatic input.\nNormal backend configuration and approvals apply. Unsupported explicit options fail before model submission.\nNo default execution deadline or automatic retry. Backend process exit and service terminal are required.\n');
