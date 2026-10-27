import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIMITS, fail, redact, safeError, fields, text, absolutePath, validateCommunication, validateInitialization } from '../runtime/contracts.mjs';
import { summarizeDiagnostics } from '../runtime/diagnostics.mjs';
import { safePath, readLimited, textFromBytes } from '../runtime/files.mjs';
import { createFrameDecoder, createFrameWriter, createProtocolState } from '../runtime/protocol.mjs';
import { safeSpawn, resolveSafeCommand } from '../runtime/platform.mjs';
import { createChildBridge } from '../runtime/adapter-channel.mjs';
import { observeTree, stopOwnedTree } from '../runtime/processes.mjs';

export { summarizeDiagnostics };

/** Resolve once in the effective backend environment, before capability preparation. */
export async function negotiateExecutable(context, command, args = [], options = {}) {
  try {
    const executable = await resolveSafeCommand(command, args, { cwd: context.request.workspace, env: context.environment, ...options });
    context.executable = executable;
    if (executable.env) context.environment = { ...executable.env };
    context.initialization = { environment: { status: 'available' }, capabilities: {} };
    return executable;
  } catch (error) {
    const safe = safeError(error);
    context.initialization = { environment: { status: 'unavailable', code: safe.code }, capabilities: {} };
    fail(safe.code, `${safe.message} Install or repair the selected CLI or PATH, or correct the executor, then start a new run.`);
  }
}

function validateNegotiation(value, context) {
  if (!fields(value, ['environment', 'capabilities', 'executable']) || !fields(value.capabilities, ['communication'])) fail('protocolInvalid', 'The adapter initialization candidate is invalid.');
  validateInitialization({ environment: value.environment, capabilities: {} });
  context.initialization = { environment: structuredClone(value.environment), capabilities: {} };
  if (value.environment.status !== 'available') fail(value.environment.code, 'The selected CLI is unavailable. Install or repair the CLI or PATH, or correct the executor, then start a new run.');
  const capability = value.capabilities.communication;
  if (!fields(capability, capability?.supported === true ? ['supported', 'transport', 'passiveDelivery', 'activeReceive'] : ['supported'])
      || typeof capability.supported !== 'boolean') fail('protocolInvalid', 'The adapter communication candidate is invalid.');
  if (capability.supported) {
    const { supported: _supported, ...details } = capability;
    validateCommunication({ status: 'enabled', ...details });
  }
  const executable = value.executable ?? context.executable;
  if (executable && (!fields(executable, ['command', 'args', 'env']) || !absolutePath(executable.command)
      || !Array.isArray(executable.args) || executable.args.some((argument) => !text(argument))
      || Object.hasOwn(executable, 'env') && (!fields(executable.env, Object.keys(executable.env ?? {})) || Object.values(executable.env).some((entry) => !text(entry))))) fail('protocolInvalid', 'The negotiated executable is invalid.');
  context.executable = executable;
  if (executable?.env) context.environment = { ...executable.env };
  context.communicationCandidate = structuredClone(capability);
}

export function rejectOption(option) {
  fail('adapterArgumentConflict', `The adapter owns ${option}. Remove it from args.`);
}

/** Protect invocation controls while leaving ordinary options to the backend. */
export function checkArguments(args, { owned, commands = [], short = {}, booleans = [], values = [], variadic = [], onOption }) {
  let valueExpected = false;
  let variadicExpected = false;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (valueExpected) { valueExpected = false; continue; }
    if (variadicExpected && !argument.startsWith('-')) continue;
    variadicExpected = false;
    if (argument === '--' || argument === '-') rejectOption(argument);
    if (!argument.startsWith('-')) fail('adapterArgumentConflict', 'args must contain backend options and their values, not a command or prompt.');
    if (argument.startsWith('--')) {
      const equals = argument.indexOf('=');
      const option = equals < 0 ? argument : argument.slice(0, equals);
      const value = equals < 0 ? args[index + 1] : argument.slice(equals + 1);
      if (owned.includes(option)) rejectOption(option);
      onOption?.(option, value);
      variadicExpected = equals < 0 && variadic.includes(option);
      valueExpected = equals < 0 && !variadicExpected && (values.includes(option) || (!booleans.includes(option) && typeof value === 'string' && !value.startsWith('-')));
      continue;
    }
    for (let offset = 1; offset < argument.length; offset++) {
      const option = `-${argument[offset]}`;
      if (owned.includes(option)) rejectOption(option);
      const kind = short[option];
      if (kind === 'value') {
        const value = argument.slice(offset + 1) || args[index + 1];
        onOption?.(option, value);
        variadicExpected = variadic.includes(option);
        valueExpected = !variadicExpected && offset + 1 === argument.length;
        break;
      }
      if (kind !== 'boolean') {
        const next = args[index + 1];
        if (commands.includes(next)) rejectOption(next);
        valueExpected = offset + 1 === argument.length && typeof next === 'string' && !next.startsWith('-');
        break;
      }
      onOption?.(option, undefined);
    }
  }
}

export async function privateOutputPath(directory, target) {
  if (typeof target !== 'string' || !path.isAbsolute(target) || path.normalize(target) !== target) fail('adapterOutputPathInvalid', 'The adapter output path must be absolute and normalized.');
  const relative = path.relative(directory, target);
  if (!relative || path.isAbsolute(relative) || relative.split(path.sep).includes('..')) fail('adapterOutputPathInvalid', 'The adapter output must stay in this private run directory.');
  await safePath(path.dirname(target), 'directory');
  try { await fs.lstat(target); fail('adapterOutputExists', 'This output already exists. Do not resubmit an existing run.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return target;
}

export async function finalOutput(target) {
  const value = textFromBytes(await readLimited(target, LIMITS.outputBytes, 'adapterOutputTooLarge'));
  await fs.chmod(target, 0o600);
  return value;
}

const instructionSections = ['common', 'mcp', 'command', 'command-argument', 'in-turn', 'turn-boundary', 'none', 'active-receive', 'no-active-receive'];

function quoteCommand(parts, shell, preferBare = false) {
  // agy treats a quoted executable as requiring a full-line permission match.
  if (shell === 'posix') return parts.map((part) => preferBare && part !== 'MESSAGE_TEXT' && /^[A-Za-z0-9_./:@%+=,-]+$/.test(part)
    ? part : `'${part.replaceAll("'", "'\\''")}'`).join(' ');
  if (shell === 'powershell') return `& ${parts.map((part) => `'${part.replaceAll("'", "''")}'`).join(' ')}`;
  fail('communicationShellUnsupported', 'Communication commands require a verified posix or powershell command tool.');
}

/** The installed template is the only source of model-facing communication prose. */
export async function renderCommunicationInstructions(communication, bridge, bindings = {}, templateUrl = new URL('../../assets/communication-instructions.md', import.meta.url)) {
  validateCommunication(communication);
  if (communication.status !== 'enabled') return '';
  if (!fields(bindings, ['sendTool', 'receiveTool', 'shell', 'sendTextMode'])
    || Object.hasOwn(bindings, 'sendTextMode') && (communication.transport !== 'command' || bindings.sendTextMode !== 'argument')) fail('runtimeResourceInvalid', 'The communication instruction bindings are invalid.');
  let template;
  try { template = textFromBytes(await readLimited(fileURLToPath(templateUrl), LIMITS.instructionBytes, 'runtimeResourceInvalid')); }
  catch { fail('runtimeResourceMissing', 'The installed communication template is missing or unreadable. Run source sync or reinstall this plugin.', ['source sync', 'reinstall']); }
  const sections = new Map();
  const expression = /<!-- aw:([a-z-]+) -->\s*([\s\S]*?)\s*<!-- \/aw:\1 -->/g;
  for (const match of template.matchAll(expression)) {
    if (!instructionSections.includes(match[1]) || sections.has(match[1])) fail('runtimeResourceInvalid', 'The communication template sections are invalid.');
    sections.set(match[1], match[2]);
  }
  if (sections.size !== instructionSections.length || template.replace(expression, '').trim()) fail('runtimeResourceInvalid', 'The communication template is incomplete. Run source sync or reinstall this plugin.', ['source sync', 'reinstall']);
  const values = {};
  if (communication.transport === 'mcp') {
    values.SEND = bindings.sendTool ?? 'send_parent';
    values.RECEIVE = bindings.receiveTool ?? 'receive_parent';
    if (![values.SEND, values.RECEIVE].every((value) => typeof value === 'string' && /^[A-Za-z0-9_.-]+$/.test(value))) fail('runtimeResourceInvalid', 'The registered MCP tool names are invalid.');
  } else {
    if (!bridge?.script || !text(bridge.script.command) || !Array.isArray(bridge.script.args) || bridge.script.args.some((value) => !text(value))) fail('runtimeResourceInvalid', 'The communication command binding is missing.');
    const invocation = [bridge.script.command, ...bridge.script.args];
    const argumentMode = bindings.sendTextMode === 'argument';
    values.SEND = quoteCommand([...invocation, 'send', '--text', argumentMode ? 'MESSAGE_TEXT' : '-'], bindings.shell, argumentMode);
    values.SENDSTDIN = quoteCommand([...invocation, 'send', '--text', '-'], bindings.shell, argumentMode);
    values.RECEIVE = quoteCommand([...invocation, 'receive', '--timeout-ms', '600000'], bindings.shell, argumentMode);
  }
  const selected = ['common', bindings.sendTextMode === 'argument' ? 'command-argument' : communication.transport, communication.passiveDelivery, communication.activeReceive ? 'active-receive' : 'no-active-receive'];
  const result = selected.map((name) => sections.get(name)).join('\n\n').replace(/@@([A-Z]+)@@/g, (_match, key) => values[key] ?? fail('runtimeResourceInvalid', 'The communication template has an undefined binding.'));
  if (/@@[A-Z]+@@/.test(result)) fail('runtimeResourceInvalid', 'The communication template contains an invalid binding.');
  return result;
}

export const collaborationInput = (text) => `Agent collaboration input from the parent (no additional human authorization):\n${text}`;
export const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  // Lifecycle cancellation can reject a request before its owner resumes.
  promise.catch(() => {});
  return { promise, resolve, reject };
};

/** Backend JSONL differs from the strict adapter wire but has the same byte discipline. */
export function backendLines(onValue, onError, maxBytes = 32 * 1024 * 1024) {
  let pending = Buffer.alloc(0);
  let failed = false;
  const parse = (line) => {
    if (line.at(-1) === 13) line = line.subarray(0, -1);
    if (!line.length || line[0] === 0xef && line[1] === 0xbb && line[2] === 0xbf) throw new Error('Invalid backend frame.');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(line);
    const value = JSON.parse(text);
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('Invalid backend frame.');
    onValue(value);
  };
  return {
    push(chunk) {
      if (failed) return;
      try {
        pending = Buffer.concat([pending, chunk]);
        for (;;) {
          const end = pending.indexOf(10);
          if (end < 0) break;
          if (end > maxBytes) throw new Error('Backend frame too large.');
          parse(pending.subarray(0, end));
          pending = pending.subarray(end + 1);
        }
        if (pending.length > maxBytes) throw new Error('Backend frame too large.');
      } catch { failed = true; onError('backendOutputInvalid'); }
    },
    end() { if (!failed && pending.length) { failed = true; onError('backendOutputInvalid'); } },
  };
}

async function launchBackend(context, command, args) {
  if (context.executable && command !== context.executable.command) fail('protocolInvalid', 'Launch the executable selected during initialization.');
  const child = await safeSpawn(command, args, { cwd: context.request.workspace, env: context.executable?.env ?? context.environment, resourceDirectory: context.request.runtime.directory, stdio: ['pipe', 'pipe', 'pipe'], shell: false, detached: false });
  const done = deferred();
  const closed = deferred();
  const token = context.environment.AW_SUBAGENT_PROCESS_TOKEN;
  let exitCode = null, exited = false, isClosed = false, known = [], observed = Promise.resolve(), observing = false;
  let stderrBytes = 0;
  let stopped = false;
  child.stdin.on('error', () => {});
  child.once('error', () => { exited = true; done.resolve(); closed.resolve(); context.abort('backendStartFailed'); });
  child.once('exit', (code) => { exitCode = code; exited = true; done.resolve(); });
  child.once('close', () => { isClosed = true; closed.resolve(); });
  child.stderr.on('data', (chunk) => {
    stderrBytes += chunk.length;
    if (stderrBytes > LIMITS.logBytes) context.abort('adapterDiagnosticTooLarge');
    context.onBackendStderr?.(chunk);
    // Raw backend diagnostics can contain credentials and unbounded service events.
    // The protocol result carries a bounded safe failure code instead.
  });
  const observe = () => {
    if (observing) return;
    observing = true;
    observed = observed.then(async () => {
      try { known = await observeTree(child.pid, known, token); }
      catch { context.abort('processObservationFailed'); }
      finally { observing = false; }
    });
  };
  const observer = setInterval(observe, 200);
  let writeQueue = Promise.resolve();
  const backend = {
    child,
    done: done.promise,
    get exitCode() { return exitCode; },
    get exited() { return exited; },
    write(value) {
      const data = typeof value === 'string' ? value : `${JSON.stringify(value)}\n`;
      const write = writeQueue.then(() => new Promise((resolve, reject) => {
        if (exited || child.stdin.destroyed || child.stdin.writableEnded) return reject(Object.assign(new Error('The backend input is closed.'), { code: 'backendInputClosed' }));
        child.stdin.write(data, (error) => error ? reject(error) : resolve());
      }));
      writeQueue = write.catch(() => {});
      return write;
    },
    async end() { await writeQueue; if (!child.stdin.destroyed) child.stdin.end(); },
    async cleanup(force = false) {
      clearInterval(observer);
      await observed;
      try {
        known = await observeTree(child.pid, known, token);
        const result = await stopOwnedTree(child.pid, known, token);
        stopped = result.stopped;
      } catch { stopped = false; }
      if (force && !exited) child.kill('SIGTERM');
      if (!isClosed) {
        let timer;
        await Promise.race([closed.promise, new Promise((resolve) => { timer = setTimeout(resolve, 1000); })]);
        clearTimeout(timer);
      }
      if (!isClosed) { child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy(); stopped = false; }
      return stopped;
    },
  };
  context.backend = backend;
  const identity = await child.identityReady;
  if (!identity) fail('backendIdentityUnavailable', 'The backend exited before its process identity could be verified.');
  known = [child.processIdentity].filter(Boolean);
  observe();
  return backend;
}

/** One reader serves control while independent backend and output tasks wait. */
export function adapterMain(moduleUrl, descriptor, help) {
  if (!process.argv[1] || fileURLToPath(moduleUrl) !== path.resolve(process.argv[1])) return;
  process.umask(0o077);
  if (process.argv.length === 3 && ['--help', '-h'].includes(process.argv[2])) { process.stdout.write(help); return; }
  if (process.argv.length !== 2) { process.stderr.write('adapterArgumentsInvalid: This adapter accepts v5 JSONL on stdin or --help.\n'); process.exitCode = 1; return; }
  const state = createProtocolState();
  const writer = createFrameWriter(process.stdout, { direction: 'adapter' });
  const deliveries = new Set();
  let context, task, closingTask, protocolFailed = false, finished = false, ready = false, closing = false, deadlineTimer, stopTimer;
  const emit = async (value) => {
    const frame = { protocolVersion: 5, ...value };
    state.acceptAdapter(frame);
    await writer.write(frame);
  };
  const shutdown = (reason, code) => {
    if (!context || finished || context.signal.aborted) return;
    context.stopReason = reason;
    context.errorCode = code ?? (reason === 'deadline' ? 'adapterDeadlineExceeded' : reason === 'requested' ? 'remoteStopUnconfirmed' : 'channelClosed');
    context.controller.abort();
    if (ready) void context.beginClosing(reason === 'requested' || reason === 'deadline' ? 'cancelled' : 'error').catch(() => {});
    void Promise.resolve().then(() => context.onStop?.()).catch(() => {});
    armClosingTimer();
  };
  const armClosingTimer = () => {
    if (stopTimer) return;
    // This bounds shutdown only. It never limits a running model turn.
    stopTimer = setTimeout(() => {
      context.errorCode ??= 'backendShutdownUnconfirmed';
      context.stopReason ??= 'channelError';
      context.controller.abort();
      void context.backend?.cleanup(true);
      context.stopped.resolve();
    }, 25000);
  };
  const run = async (request) => {
    const controller = new AbortController();
    context = {
      request, environment: process.env, controller, signal: controller.signal, generationStarted: false,
      stopReason: null, errorCode: null, backend: null, bridge: null, stopped: deferred(),
      communication: null, initialization: null, executable: null, communicationCandidate: null, prompt: request.prompt, diagnostics: [],
      emit, abort: (code) => shutdown('channelError', code),
      async ready(diagnostics = []) {
        if (context.signal.aborted) return;
        if (!context.communication) fail('communicationNotPrepared', 'Prepare communication before reporting ready.');
        context.initialization.capabilities.communication = structuredClone(context.communication);
        validateInitialization(context.initialization, { ready: true });
        context.diagnostics.push(...diagnostics);
        const safe = summarizeDiagnostics(context.diagnostics, context.environment);
        await emit({ type: 'ready', initialization: context.initialization, ...(safe.length ? { diagnostics: safe } : {}) });
        ready = true;
      },
      async prepareCommunication({ submitInput, canSubmitInput, instructionBindings } = {}) {
        if (context.communication) fail('communicationAlreadyPrepared', 'Communication must be prepared once.');
        if (!request.communication) {
          context.communication = { status: 'disabled' };
          context.initialization.capabilities.communication = context.communication;
          return;
        }
        const capability = context.communicationCandidate;
        if (!capability) fail('initializationMissing', 'Negotiate the environment and capabilities before preparing communication.');
        if (!capability.supported) {
          context.communication = { status: 'unsupported' };
          context.initialization.capabilities.communication = context.communication;
          return;
        }
        const { supported: _supported, ...details } = capability;
        const communication = validateCommunication({ status: 'enabled', ...details });
        if (request.mode === 'bundle') fail('protocolInvalid', 'Bundle runs cannot enable communication.');
        if (communication.passiveDelivery !== 'none' && typeof submitInput !== 'function') fail('bridgeInvalid', 'Passive communication requires an input submission method.');
        context.bridge = await createChildBridge({
          directory: path.join(request.runtime.directory, 'communication'), deadlineAt: request.run.deadlineAt,
          toolkit: request.runtime.toolkit, activeReceive: communication.activeReceive,
          emitParentMessage: async (text) => {
            try { await emit({ type: 'message', text }); }
            catch (error) { context.abort('channelWriteFailed'); throw error; }
          }, submitInput: communication.passiveDelivery === 'none' ? undefined : submitInput, canSubmitInput,
        });
        try {
          const instructions = await renderCommunicationInstructions(communication, context.bridge, instructionBindings);
          context.prompt = `${request.prompt}\n\n${instructions}`;
          context.communication = communication;
        } catch (error) { await context.bridge.close('error'); throw error; }
        return context.bridge;
      },
      async beginClosing(reason) {
        if (!ready) return;
        if (closing) return closingTask;
        closing = true;
        armClosingTimer();
        closingTask = (async () => {
          await context.bridge?.close(reason);
          await Promise.allSettled([...deliveries]);
          await emit({ type: 'closing', reason });
        })();
        return closingTask;
      },
    };
    context.spawn = (command, args) => launchBackend(context, command, args);
    if (request.run.deadlineAt !== null) {
      const tick = () => {
        if (finished || context.signal.aborted) return;
        const remaining = request.run.deadlineAt - Date.now();
        if (remaining <= 0) shutdown('deadline');
        else deadlineTimer = setTimeout(tick, Math.min(remaining, 2147483647));
      };
      tick();
    }
    let result;
    try {
      if (!/^[a-f0-9]{48}$/.test(process.env.AW_SUBAGENT_PROCESS_TOKEN ?? '')) fail('processMarkerMissing', 'Run this adapter through the Guide runner.');
      if (request.mode !== descriptor.mode) fail('adapterModeUnsupported', `This adapter requires ${descriptor.mode} mode.`);
      if (descriptor.permissionMode === true ? !Object.hasOwn(request, 'permissionMode') : Object.hasOwn(request, 'permissionMode')) fail('protocolInvalid', 'The permission mode must match the selected adapter.');
      if (descriptor.codex === true ? !Object.hasOwn(request, 'codex') : Object.hasOwn(request, 'codex')) fail('protocolInvalid', 'The Codex configuration must match the selected adapter.');
      await safePath(request.workspace, 'directory');
      await safePath(request.runtime.directory, 'directory');
      if (context.signal.aborted) throw Object.assign(new Error('The task was stopped before submission.'), { code: context.errorCode });
      if (typeof descriptor.negotiate !== 'function') fail('initializationNegotiationMissing', 'The adapter must negotiate the environment and capabilities before model input.');
      validateNegotiation(await descriptor.negotiate(context), context);
      if (context.signal.aborted) throw Object.assign(new Error('The task was stopped before submission.'), { code: context.errorCode });
      result = await descriptor.execute(context);
    } catch (error) {
      const safe = safeError(error);
      result = { state: context.generationStarted === false ? 'failed' : 'unknown', code: safe.code, message: redact(safe.message, process.env).slice(0, 2048), text: '' };
    }
    try {
      if (context.backend) {
        const stopped = await context.backend.cleanup();
        result.backendExitCode = context.backend.exitCode;
        if (!stopped) Object.assign(result, { state: 'unknown', code: 'localTreeStopUnconfirmed' });
      }
      if (context.signal.aborted) {
        const beforeSubmission = context.generationStarted === false;
        Object.assign(result, {
          state: beforeSubmission ? ['requested', 'deadline'].includes(context.stopReason) ? 'cancelled' : 'failed' : 'unknown',
          code: context.errorCode, ...(beforeSubmission ? {} : { remoteStopConfirmed: false }),
        });
      }
      if (result.state === 'completed' && (result.backendExitCode !== 0 || context.generationStarted !== true || !result.text?.trim())) Object.assign(result, { state: 'unknown', code: 'serviceTerminalConflict' });
      await context.beginClosing(result.state === 'completed' ? 'completed' : result.state === 'cancelled' ? 'cancelled' : 'failed');
      await context.bridge?.close('error');
      await Promise.allSettled([...deliveries]);
      if (!ready && result.state === 'unknown' && context.generationStarted === false) result.state = 'failed';
      const final = { type: 'result', generationStarted: context.generationStarted, backendExitCode: context.backend?.exitCode ?? null, ...result };
      if (context.initialization) final.initialization = context.initialization;
      const diagnostics = summarizeDiagnostics(context.diagnostics, context.environment);
      if (diagnostics.length) final.diagnostics = diagnostics;
      final.text = redact(final.text ?? '', process.env);
      if (final.message) final.message = redact(final.message, process.env).slice(0, 2048);
      await emit(final);
    } finally {
      finished = true;
      clearTimeout(deadlineTimer); clearTimeout(stopTimer);
      process.stdin.destroy();
    }
  };
  const protocolError = () => {
    if (protocolFailed) return;
    protocolFailed = true;
    if (context) shutdown('channelError', 'protocolInvalid');
    else { process.stderr.write('protocolInvalid: Invalid Adapter v5 input.\n'); process.exitCode = 1; process.stdin.destroy(); }
  };
  const decoder = createFrameDecoder({ direction: 'worker', onFrame(frame) {
    try {
      state.acceptWorker(frame);
      if (frame.type === 'start') {
        task = run(frame);
        task.catch((error) => { const safe = safeError(error); process.stderr.write(`${safe.code}: ${redact(safe.message, process.env)}\n`); process.exitCode = 1; process.stdin.destroy(); });
      } else if (frame.type === 'stop') shutdown(frame.reason);
      else if (frame.type === 'message') {
        const delivery = closing ? Promise.resolve({ status: 'notSubmitted', code: 'runClosed' }) : context.bridge.acceptInput({ id: frame.id, text: frame.text });
        const pending = delivery.then((value) => emit({ type: 'delivery', id: frame.id, ...value })).catch(() => shutdown('channelError', 'deliveryFailed'));
        deliveries.add(pending);
        pending.finally(() => deliveries.delete(pending));
      }
    } catch { protocolError(); }
  } });
  process.stdin.on('data', (chunk) => { if (protocolFailed) return; try { decoder.push(chunk); } catch { protocolError(); } });
  process.stdin.on('end', () => { try { decoder.end(); } catch { protocolError(); } if (!context) { protocolError(); return; } if (!finished) shutdown('channelError', 'channelClosed'); });
  process.stdin.on('error', () => { if (!finished) shutdown('channelError', 'channelClosed'); });
  process.stdout.on('error', () => shutdown('channelError', 'channelWriteFailed'));
  process.on('SIGINT', () => shutdown('requested'));
  process.on('SIGTERM', () => shutdown('requested'));
}
