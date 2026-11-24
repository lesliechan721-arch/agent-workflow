#!/usr/bin/env node
import path from 'node:path';
import { ADAPTER_PROTOCOL_VERSION, fail, LIMITS } from '../runtime/contracts.mjs';
import { mapHookState } from './codex-hooks.mjs';
import { resolveCodexExecutable } from './codex-executable.mjs';
import { assertNoReparsePath, resolveSafeCommand } from '../runtime/platform.mjs';
import { adapterMain, backendLines, collaborationInput, deferred } from './common.mjs';
import { checkCodexArguments } from './codex-arguments.mjs';
import { permissionMode, watchPermissionFallback } from './permission-mode.mjs';

export { checkCodexArguments };

/** Profile and explicit options are merged once before choosing their phase. */
export async function codexConfiguration(request, environment = process.env, diagnostics = []) {
  if (!request.codex || !['auto', 'cli', 'app'].includes(request.codex.cliSource) || typeof request.codex.bypassHookTrust !== 'boolean') fail('adapterProtocolInvalid', 'Codex requires an explicit CLI source and hook bypass setting.');
  const { readCodexConfiguration, splitConfiguration, buildCodexLaunchArgs } = await import('./codex-profile.mjs');
  const { merged, defaults, raw, extras, ephemeral, profilePath } = await readCodexConfiguration(request.args, {
    profile: request.codex.profile, workspace: request.workspace, environment, diagnostics,
    privateMcpServer: request.communication === false ? undefined : `aw_parent_${request.run.id}`,
    permissionMode: permissionMode(request),
    model: request.execution.model, reasoningEffort: request.execution.reasoningEffort,
  });
  const thread = { cwd: request.workspace, ...(ephemeral ? { ephemeral: true } : {}) };
  const turn = {};
  if (permissionMode(request) === 'auto') { merged.approval_policy = 'on-request'; merged.approvals_reviewer = 'auto_review'; }
  else if (permissionMode(request) === 'full-access') { merged.approval_policy = 'never'; merged.sandbox_mode = 'danger-full-access'; }
  if (request.execution.model !== undefined) merged.model = request.execution.model;
  if (request.execution.reasoningEffort !== undefined) {
    merged.model_reasoning_effort = request.execution.reasoningEffort;
    turn.effort = request.execution.reasoningEffort;
  }
  if (Object.hasOwn(merged, 'model')) { thread.model = merged.model; delete merged.model; }
  const split = splitConfiguration(merged, { diagnostics });
  thread.config = { ...split.thread, bypass_hook_trust: request.codex.bypassHookTrust };
  if (request.codex.bypassHookTrust) diagnostics.push({ code: 'hookTrustBypassed', field: 'codexBypassHookTrust', message: 'Hook trust is bypassed for this thread, including other native hook sources. Disabled hooks and managed restrictions remain in force.' });
  // Source-state mapping runs after JSON routing; retain its metadata in the
  // same representation so unknown state members cannot reintroduce BigInts.
  const jsonHooks = (hooks) => hooks === undefined ? undefined : splitConfiguration({ hooks }, { diagnostics }).thread.hooks;
  return { argv: buildCodexLaunchArgs({ launch: split.launch, extras }), thread, turn, startupMcp: Object.hasOwn(split.launch, 'mcp_servers'), profilePath, profileHooks: jsonHooks(defaults.hooks), rawHooks: jsonHooks(raw.hooks) };
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
  const executable = context.executable;
  watchPermissionFallback(context);
  const backend = await context.spawn(executable.command, [...(executable.args ?? []), ...configuration.argv]);
  rpc = createRpc(backend, context, (method, params) => {
    if (method === 'configWarning') {
      // Native messages can contain configuration values, paths or credentials.
      // Record their presence without treating ordinary warnings as failures.
      if (!context.diagnostics.some((entry) => entry.code === 'backendConfigWarning')) context.diagnostics.push({ code: 'backendConfigWarning', message: 'Codex reported a configuration warning. Native defaults or fallback behavior may apply; check the selected Codex configuration.' });
      return;
    }
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
    await rpc.call('initialize', { clientInfo: { name: 'aw-subagent', version: String(ADAPTER_PROTOCOL_VERSION) }, capabilities: {} });
    await rpc.notify('initialized');
    let inherited;
    if (configuration.thread.config.hooks) {
      let layers;
      try { layers = await rpc.call('config/read', { cwd: context.request.workspace, includeLayers: true }); }
      catch { fail('profileHookStateUnavailable', 'The backend could not return raw hook state layers.'); }
      mapHookState(configuration, layers);
      inherited = layers.config;
    }
    if (bridge) {
      const fullAccess = (config) => config?.approval_policy === 'never' && config?.sandbox_mode === 'danger-full-access';
      // Resume can restore persisted permissions instead of current defaults.
      // Only explicit overrides establish full access before that response.
      if (!context.request.sessionId && !fullAccess(configuration.thread.config) && inherited === undefined) {
        try { inherited = (await rpc.call('config/read', { cwd: context.request.workspace, includeLayers: false }))?.config; }
        catch (error) {
          // An unavailable read cannot establish full access. Keep the precise
          // tool grants; a lost connection still retains its failure evidence.
          if (!error.rpcError) throw error;
        }
      }
      const approval = fullAccess({ ...(!context.request.sessionId ? inherited : {}), ...configuration.thread.config }) ? {} : { approval_mode: 'approve' };
      const tools = { receive_parent: { ...approval, output_token_limit: 32768 } };
      if (approval.approval_mode) tools.send_parent = { ...approval };
      const binding = { command: bridge.mcpServer.command, args: bridge.mcpServer.args, required: true, tools };
      // A whole request table would replace an existing startup override table.
      // The AW-generated server name contains no dots or TOML quoting characters.
      if (configuration.startupMcp) configuration.thread.config[`mcp_servers.${server}`] = binding;
      else configuration.thread.config.mcp_servers = { ...configuration.thread.config.mcp_servers, [server]: binding };
    }
    const response = context.request.sessionId
      ? await rpc.call('thread/resume', { ...configuration.thread, threadId: context.request.sessionId })
      : await rpc.call('thread/start', configuration.thread);
    threadId = response?.thread?.id;
    if (typeof threadId !== 'string' || !threadId) fail('backendOutputInvalid', 'The backend did not return a thread ID.');
    if (context.request.sessionId && (response.thread.status?.type === 'active' || response.thread.turns?.some((turn) => turn.status === 'inProgress'))) fail('backendInputUnavailable', 'The original backend thread still has an active turn.');
    await context.bindSession(threadId);
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

export async function negotiateCodexCommunication() { return { supported: true, transport: 'mcp', passiveDelivery: 'in-turn' }; }

export async function negotiateCodex(context) {
  checkCodexArguments(context.request);
  if (!context.request.codex || !['auto', 'cli', 'app'].includes(context.request.codex.cliSource) || typeof context.request.codex.bypassHookTrust !== 'boolean') fail('adapterProtocolInvalid', 'Codex requires an explicit CLI source and hook bypass setting.');
  let executable;
  try {
    executable = await resolveCodexExecutable({
      source: context.request.codex.cliSource, environment: context.environment, cwd: context.request.workspace,
      resolveCommand: resolveSafeCommand, checkWindowsPath: assertNoReparsePath, signal: context.signal,
    });
  }
  catch (error) {
    context.signal?.throwIfAborted();
    if (error.diagnostic) context.diagnostics.push(error.diagnostic);
    context.initialization = { environment: { status: 'unavailable', code: error.code ?? 'codexExecutableInvalid' }, capabilities: {} };
    throw error;
  }
  context.initialization = { environment: { status: 'available' }, capabilities: {} };
  if (executable.diagnostic) context.diagnostics.push(executable.diagnostic);
  const { diagnostic: _diagnostic, ...invocation } = executable;
  return { environment: { status: 'available' }, executable: invocation, capabilities: { communication: { supported: true, transport: 'mcp', passiveDelivery: 'in-turn' }, resume: { supported: !context.request.args.includes('--ephemeral') } } };
}

adapterMain(import.meta.url, { codex: true, permissionMode: true, introspection: 'codex', negotiate: negotiateCodex, execute: executeCodex }, 'Codex Adapter v6\nUsage: node codex-v6.mjs\nReads one persistent v6 JSONL connection. Uses PATH codex app-server, private parent tools, and automatic input.\nNormal backend configuration and approvals apply. Unsupported explicit options fail before model submission.\nNo default execution deadline or automatic retry. Backend process exit and service terminal are required.\n');
