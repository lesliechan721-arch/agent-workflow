#!/usr/bin/env node
import { LIMITS, fail, identifier, object, text as validText } from '../runtime/contracts.mjs';
import { adapterMain, backendLines, deferred } from './common.mjs';
import { antigravityArguments } from './antigravity-arguments.mjs';

export { antigravityArguments, checkAntigravityArguments } from './antigravity-arguments.mjs';

export async function negotiateAntigravityCommunication() {
  // Public stream-json examples do not prove command permissions, pre-input
  // init timing, or the correlation of a new user_input step with our write.
  // Keep the bidirectional path blocked until real backend evidence exists.
  fail('antigravityCommunicationUnverified', 'Antigravity command permissions and input acceptance are not verified. Set communication:false for ordinary tasks, or qualify the bidirectional command path before enabling it.');
}

export async function executeAntigravity(context) {
  const args = antigravityArguments(context.request);
  await context.prepareCommunication();
  if (context.signal.aborted) return { state: 'cancelled', code: context.errorCode, text: '' };
  const backend = await context.spawn('agy', args);
  const turnEnded = deferred();
  let sessionId, terminal, response = '', attempted = false, acceptedStep, stopping;
  const invalid = (code = 'backendOutputInvalid') => context.abort(code);
  const lines = backendLines((value) => {
    if (context.signal.aborted) return;
    if (value.event === 'init') {
      if (sessionId || !identifier(value.conversation_id) || !object(value.init)) return invalid();
      sessionId = value.conversation_id;
    } else if (value.event === 'step_update') {
      const step = value.step_update;
      if (!object(step) || !identifier(step.conversation_id) || !Number.isSafeInteger(step.step_index) || step.step_index < 0 || !['ACTIVE', 'DONE'].includes(step.state) || typeof step.step_type !== 'string') return invalid();
      if (!sessionId || sessionId !== step.conversation_id) return invalid('backendSessionMismatch');
      if (!attempted || terminal) return invalid();
      if (step.step_type === 'user_input' && step.state === 'DONE') {
        if (acceptedStep !== undefined && acceptedStep !== step.step_index) return invalid();
        // With communication disabled there is one input only. This public
        // event is necessary completion evidence, not a qualified parent ACK.
        acceptedStep = step.step_index;
      } else if (step.step_type === 'agent_response' || step.step_type === 'tool') context.generationStarted = true;
    } else if (value.event === 'result') {
      const result = value.result;
      if (terminal || !object(result) || typeof result.status !== 'string' || !validText(result.response) || !Number.isSafeInteger(result.num_turns) || result.num_turns < 0) return invalid();
      const initializationError = result.status === 'ERROR' && result.num_turns === 0 && result.conversation_id === '';
      if (!initializationError && (!sessionId || result.conversation_id !== sessionId)) return invalid('backendSessionMismatch');
      if (Buffer.byteLength(result.response) > LIMITS.outputBytes) return invalid('adapterOutputTooLarge');
      terminal = result;
      response = result.response;
      turnEnded.resolve();
    } else invalid();
  }, invalid);
  backend.child.stdout.on('data', (chunk) => lines.push(chunk));
  backend.child.stdout.on('end', () => lines.end());
  context.onStop = () => stopping ??= backend.cleanup().finally(() => context.stopped.resolve());
  await context.ready();
  if (context.signal.aborted) {
    await context.onStop();
    return { state: 'cancelled', code: context.errorCode, text: '' };
  }
  if (!backend.exited && !terminal) {
    attempted = true;
    context.generationStarted = null;
    try { await backend.write({ event: 'user', message: { content: context.prompt } }); }
    catch { invalid('backendResponseUnknown'); }
  }
  const aborted = new Promise((resolve) => {
    if (context.signal.aborted) resolve();
    else context.signal.addEventListener('abort', resolve, { once: true });
  });
  await Promise.race([turnEnded.promise, backend.done, context.stopped.promise, aborted]);
  if (context.signal.aborted) await context.onStop();
  else {
    const successfulTurn = terminal?.status === 'SUCCESS' && terminal.num_turns === 1 && acceptedStep !== undefined && response.trim();
    await context.beginClosing(successfulTurn ? 'completed' : 'failed');
    await backend.end();
    await Promise.race([backend.done, context.stopped.promise, aborted]);
    if (context.signal.aborted) await context.onStop();
  }
  const result = { text: response, ...(sessionId ? { sessionId } : {}) };
  if (context.signal.aborted) return { ...result, state: 'unknown', code: context.errorCode };
  if (!terminal) return { ...result, state: attempted ? 'unknown' : 'failed', code: 'serviceTerminalUnconfirmed' };
  if (terminal.status === 'ERROR') return { ...result, state: 'failed', code: 'backendFailed' };
  if (terminal.status !== 'SUCCESS' || terminal.num_turns !== 1 || acceptedStep === undefined || backend.exitCode !== 0 || !response.trim()) return { ...result, state: 'unknown', code: 'serviceTerminalConflict' };
  context.generationStarted = true;
  return { ...result, state: 'completed' };
}

adapterMain(import.meta.url, {
  mode: 'workspace',
  negotiateCommunication: negotiateAntigravityCommunication,
  execute: executeAntigravity,
}, 'Antigravity Adapter v5\nUsage: node antigravity-v5.mjs\nReads one persistent v5 JSONL connection and uses PATH agy stream-json.\nCommunication requires backend qualification and currently fails before task submission; use communication:false for ordinary tasks.\nNormal configuration and permissions apply. No implicit approval, default execution deadline, or automatic retry.\n');
