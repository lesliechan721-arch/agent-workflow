#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { LIMITS, fail, identifier, object, redact, text as validText } from '../runtime/contracts.mjs';
import { adapterMain, backendLines, collaborationInput, deferred, negotiateExecutable } from './common.mjs';
import { antigravityArguments, antigravityFullAccess } from './antigravity-arguments.mjs';
import { watchPermissionFallback } from './permission-mode.mjs';
import { prepareAntigravityPermission } from './antigravity-permissions.mjs';
import { communicationCommand } from '../runtime/managed-host.mjs';

export { antigravityArguments, checkAntigravityArguments } from './antigravity-arguments.mjs';

const execFileAsync = promisify(execFile);

function antigravityFailure(result, environment) {
  let message = validText(result.error) && result.error.trim()
    ? `Antigravity reported ERROR: ${result.error}`
    : 'Antigravity reported ERROR without a valid error description.';
  message = redact(message, environment);
  // Leave room in the 640-byte display budget for the startup recovery hint.
  const maximumBytes = 512;
  if (Buffer.byteLength(message) > maximumBytes) {
    const suffix = ' [truncated]';
    let prefix = '', bytes = Buffer.byteLength(suffix);
    for (const character of message) {
      bytes += Buffer.byteLength(character);
      if (bytes > maximumBytes) break;
      prefix += character;
    }
    message = prefix + suffix;
  }
  return { state: 'failed', code: 'backendFailed', message };
}

async function checkAntigravityVersion(context, executable) {
  let stdout;
  try {
    ({ stdout } = await execFileAsync(executable.command, [...executable.args, '--version'], {
      cwd: context.request.workspace, env: executable.env ?? context.environment,
      encoding: 'utf8', timeout: 5000, maxBuffer: 65536, windowsHide: true,
      killSignal: 'SIGKILL', signal: context.signal,
    }));
  } catch {
    context.initialization.environment = { status: 'unavailable', code: 'antigravityVersionCheckFailed' };
    fail('antigravityVersionCheckFailed', 'The agy version query failed. Repair agy 1.4.10 or later on the selected PATH, then start a new run.');
  }
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(stdout.trim());
  const version = match?.slice(1).map(Number);
  if (!version?.every(Number.isSafeInteger) || version[0] < 1 || version[0] === 1 && (version[1] < 4 || version[1] === 4 && version[2] < 10)) {
    context.initialization.environment = { status: 'unavailable', code: 'antigravityVersionUnsupported' };
    fail('antigravityVersionUnsupported', 'The Antigravity adapter requires agy 1.4.10 or later with session --settings support. Upgrade the selected agy, then start a new run.');
  }
}

export async function negotiateAntigravityCommunication() {
  return { supported: true, transport: 'command', passiveDelivery: 'turn-boundary' };
}

export async function negotiateAntigravity(context) {
  antigravityArguments(context.request);
  const executable = await negotiateExecutable(context, 'agy');
  await checkAntigravityVersion(context, executable);
  const communication = context.request.communication ? await negotiateAntigravityCommunication(context) : { supported: false };
  return { environment: { status: 'available' }, executable, capabilities: { communication, resume: { supported: true } } };
}

export async function executeAntigravity(context) {
  const args = antigravityArguments(context.request);
  const initialized = deferred(), completed = deferred();
  let backend, sessionId, terminal, response = '', active = false, pending, stopping;
  let firstSent = false, scheduled = false, maxStep = -1, lastUserStep = -1, inputCount = 0, acceptedCount = 0, deniedActions = 0;
  const terminalSucceeded = () => terminal?.status === 'SUCCESS' && Boolean(response.trim());
  const invalid = (code = 'backendOutputInvalid') => context.abort(code);
  const aborted = new Promise((resolve) => {
    if (context.signal.aborted) resolve();
    else context.signal.addEventListener('abort', resolve, { once: true });
  });
  const maybeComplete = () => {
    if (scheduled || !terminal || active || pending || context.signal.aborted) return;
    scheduled = true;
    setImmediate(() => {
      scheduled = false;
      if (!terminal || active || pending || context.signal.aborted || terminalSucceeded() && context.bridge?.hasPendingInput()) return;
      void context.beginClosing(terminalSucceeded() ? 'completed' : 'failed').then(() => completed.resolve()).catch(completed.reject);
    });
  };
  const sendInput = async (input, signal) => {
    if (signal?.aborted || context.signal.aborted) return { status: 'notSubmitted', code: 'runClosed' };
    if (active || pending || backend.exited || inputCount > 0 && !terminalSucceeded()) return { status: 'notSubmitted', code: 'backendInputUnavailable' };
    const acknowledgement = deferred();
    const submitted = { baseline: maxStep, acknowledgement };
    pending = submitted;
    active = true;
    terminal = undefined;
    deniedActions = 0;
    inputCount++;
    try {
      await backend.write({ event: 'user', message: { content: input } });
      return await acknowledgement.promise;
    } catch {
      return { status: 'unknown', code: 'backendResponseUnknown' };
    } finally {
      if (pending === submitted && (context.signal.aborted || backend.exited)) pending = undefined;
      maybeComplete();
    }
  };
  const commandBinding = context.request.communication ? await communicationCommand(context.environment) : undefined;
  const bridge = await context.prepareCommunication({
    commandBinding,
    instructionBindings: { shell: process.platform === 'win32' ? 'powershell' : 'posix', sendTextMode: 'argument' },
    canSubmitInput: () => firstSent && !active && !pending && terminalSucceeded() && !context.signal.aborted,
    submitInput: ({ text }, { signal }) => sendInput(collaborationInput(text), signal),
  });
  if (bridge && !antigravityFullAccess(context.request)) {
    const permission = await prepareAntigravityPermission({ environment: context.environment, command: commandBinding.command, args: commandBinding.args, directory: context.request.runtime.directory });
    args.push('--settings', permission.settingsFile);
    context.diagnostics.push({ code: 'communicationPermissionSession', message: 'Exact Antigravity communication allow rules were prepared for this session. No communication rules were saved to user settings.' });
  }
  if (context.signal.aborted) return { state: 'cancelled', code: context.errorCode, text: '' };
  watchPermissionFallback(context);
  backend = await context.spawn(context.executable.command, [...(context.executable.args ?? []), ...args]);
  const lines = backendLines((value) => {
    if (context.signal.aborted) return;
    if (value.event === 'init') {
      if (sessionId || !identifier(value.conversation_id) || !object(value.init)) return invalid();
      if (context.request.sessionId && context.request.sessionId !== value.conversation_id) return invalid('backendSessionMismatch');
      sessionId = value.conversation_id;
      void context.bindSession(sessionId).catch((error) => invalid(error.code ?? 'backendSessionMismatch'));
      if (bridge && (!Array.isArray(value.init.tools) || !value.init.tools.includes('run_command'))) return invalid('communicationToolUnavailable');
      if (bridge && value.init.permission_mode === 'strict') return invalid('communicationPermissionDenied');
      initialized.resolve();
    } else if (value.event === 'step_update') {
      const step = value.step_update;
      if (!object(step) || !identifier(step.conversation_id) || !Number.isSafeInteger(step.step_index) || step.step_index < 0 || typeof step.step_type !== 'string' || !['ACTIVE', 'DONE'].includes(step.state) && !(step.step_type === 'tool' && step.state === 'ERROR')) return invalid();
      if (!sessionId || sessionId !== step.conversation_id) return invalid('backendSessionMismatch');
      if (step.step_index < maxStep) return invalid();
      maxStep = step.step_index;
      if (!firstSent || terminal) return invalid();
      if (step.step_type === 'user_input' && step.state === 'DONE') {
        if (step.step_index === lastUserStep) return;
        if (!pending || step.step_index <= pending.baseline) return invalid('backendInputAcceptanceInvalid');
        lastUserStep = step.step_index;
        acceptedCount++;
        context.generationStarted = true;
        const accepted = pending;
        pending = undefined;
        accepted.acknowledgement.resolve({ status: 'submitted' });
      } else if (step.step_type === 'agent_response' || step.step_type === 'tool') context.generationStarted = true;
    } else if (value.event === 'result') {
      const result = value.result;
      if (terminal || !object(result) || typeof result.status !== 'string' || !validText(result.response) || !Number.isSafeInteger(result.num_turns) || result.num_turns < 0) return invalid();
      if (result.denied_actions !== undefined && (!Array.isArray(result.denied_actions) || result.denied_actions.some((action) => !object(action) || typeof action.action !== 'string' || !action.action.trim()))) return invalid();
      const initializationError = result.status === 'ERROR' && result.num_turns === 0 && result.conversation_id === '';
      if (!initializationError && (!sessionId || result.conversation_id !== sessionId)) return invalid('backendSessionMismatch');
      if (Buffer.byteLength(result.response) > LIMITS.outputBytes) return invalid('adapterOutputTooLarge');
      if (initializationError && !firstSent) { terminal = result; completed.resolve(); initialized.resolve(); return; }
      if (!active || pending || acceptedCount !== inputCount) return invalid('backendInputAcceptanceInvalid');
      terminal = result;
      response = result.response;
      deniedActions = result.denied_actions?.length ?? 0;
      if (deniedActions) context.diagnostics.push({ code: 'backendActionDenied', message: `Antigravity reported ${deniedActions} denied tool action${deniedActions === 1 ? '' : 's'}.` });
      active = false;
      if (result.status !== 'SUCCESS') { completed.resolve(); return; }
      // The bridge scanner observes canSubmitInput at the turn boundary.
      // Active receive and automatic delivery consume the same queue.
      maybeComplete();
    } else invalid();
  }, invalid);
  backend.child.stdout.on('data', (chunk) => lines.push(chunk));
  backend.child.stdout.on('end', () => lines.end());
  backend.done.then(() => pending?.acknowledgement.resolve({ status: 'unknown', code: 'backendResponseUnknown' }));
  context.signal.addEventListener('abort', () => pending?.acknowledgement.resolve({ status: 'unknown', code: context.errorCode }), { once: true });
  context.onStop = () => stopping ??= backend.cleanup().finally(() => context.stopped.resolve());
  let initializationTimer;
  try {
    await Promise.race([initialized.promise, backend.done, aborted, new Promise((resolve) => { initializationTimer = setTimeout(() => { invalid('backendInitializationTimeout'); resolve(); }, 30000); })]);
  } finally { clearTimeout(initializationTimer); }
  if (context.signal.aborted) {
    await context.onStop();
    return { state: 'failed', code: context.errorCode, text: '' };
  }
  if (terminal?.status === 'ERROR') return { ...antigravityFailure(terminal, context.environment), text: '' };
  if (!sessionId || terminal || backend.exited) return { state: 'failed', code: 'backendInitializationFailed', text: '' };
  await context.ready();
  if (!context.signal.aborted && !backend.exited) {
    firstSent = true;
    context.generationStarted = null;
    void sendInput(context.prompt).then((delivery) => {
      if (delivery.status !== 'submitted' && !terminal && !context.signal.aborted) invalid(delivery.code);
    });
  }
  await Promise.race([completed.promise, backend.done, context.stopped.promise, aborted]);
  if (context.signal.aborted) await context.onStop();
  else {
    await context.beginClosing(terminalSucceeded() ? 'completed' : 'failed');
    await backend.end();
    await Promise.race([backend.done, context.stopped.promise, aborted]);
    if (context.signal.aborted) await context.onStop();
  }
  const result = { text: response, ...(sessionId ? { sessionId } : {}) };
  if (context.signal.aborted) return { ...result, state: 'unknown', code: context.errorCode };
  if (!terminal) return { ...result, state: 'unknown', code: 'serviceTerminalUnconfirmed' };
  if (terminal.status === 'ERROR') return { ...result, ...antigravityFailure(terminal, context.environment) };
  if (terminal.status === 'SUCCESS' && !response.trim() && deniedActions) return { ...result, state: 'failed', code: 'backendActionDenied' };
  if (terminal.status !== 'SUCCESS' || inputCount < 1 || acceptedCount !== inputCount || backend.exitCode !== 0 || !response.trim()) return { ...result, state: 'unknown', code: 'serviceTerminalConflict' };
  context.generationStarted = true;
  return { ...result, state: 'completed' };
}

adapterMain(import.meta.url, {
  mode: 'workspace', permissionMode: true, negotiate: negotiateAntigravity,
  execute: executeAntigravity,
}, 'Antigravity Adapter v5\nUsage: node antigravity-v5.mjs\nReads one persistent v5 JSONL connection and uses PATH agy stream-json.\nCommunication uses command tools, turn-boundary parent input, and active receive. Normal configuration and exact command permissions apply.\nNo implicit approval, default execution deadline, or automatic retry.\n');
