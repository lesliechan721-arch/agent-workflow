import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { channel } from 'node:diagnostics_channel';
import { LIMITS, RuntimeError, absolutePath, epochMs, fail, fields, messageId, validateDelivery, validateMessageText } from './contracts.mjs';
import { atomicJson, readJson } from './files.mjs';
import { assertNoReparsePath, protectPrivatePath, verifyPrivatePath } from './platform.mjs';

const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const errorResponse = (code, message) => ({ outcome: 'error', code, message });
const unsubmitted = () => ({ status: 'notSubmitted', code: 'runClosed', message: 'The run is closed.' });
const uncertain = () => ({ status: 'unknown', code: 'inputDeliveryUnknown', message: 'Input submission could not be confirmed.' });
const closedResponse = (operation) => operation === 'send' ? errorResponse('runClosed', 'The run is closed.') : { outcome: 'closed' };
const validTimeout = (value) => Number.isSafeInteger(value) && value >= 0 && value <= LIMITS.maximumWaitMs;
const token = () => randomBytes(16).toString('hex');
const diagnostics = channel('aw.subagent.bridge');
const note = (phase, values = {}) => diagnostics.publish({ phase, ...values });

/** Shared queue semantics, independent of the private file transport. */
export function createChildChannel({ emitParentMessage, submitInput, canSubmitInput, onError } = {}) {
  if (typeof emitParentMessage !== 'function' || (submitInput !== undefined && typeof submitInput !== 'function')
      || (canSubmitInput !== undefined && typeof canSubmitInput !== 'function')
      || (onError !== undefined && typeof onError !== 'function')) fail('bridgeInvalid', 'The child channel configuration is invalid.');
  let closed = false; let closingPromise; let receiving = null; let receiveActive = false; let submitting = false;
  const inputs = []; const pendingInputs = new Set(); const seenIds = new Set();
  const sends = new Set(); const submissions = new Set();
  const cancelReceives = new Map();
  const abortSubmission = new AbortController();
  const settle = (entry, delivery) => {
    if (!pendingInputs.delete(entry)) return;
    entry.resolve(delivery);
  };
  const schedule = () => {
    if (closed || !inputs.length) return;
    if (receiving) {
      const waiter = receiving; receiving = null; clearTimeout(waiter.timer);
      const entry = inputs.shift(); entry.attempted = true;
      waiter.resolve({ outcome: 'received', text: entry.text, entry });
      return;
    }
    if (!submitInput || submitting) return;
    // A turn-boundary wait must leave the input available to explicit receive.
    if (canSubmitInput) {
      let available;
      try { available = canSubmitInput(); } catch { void close('error'); onError?.(); return; }
      if (available !== true) { if (available !== false) { void close('error'); onError?.(); } return; }
    }
    const entry = inputs.shift(); entry.attempted = true; submitting = true;
    // Submission runs outside the scanner, so receive and stop remain responsive.
    const submittingInput = Promise.resolve().then(() => submitInput({ id: entry.id, text: entry.text }, { signal: abortSubmission.signal }))
      .then((delivery) => { validateDelivery(delivery); settle(entry, delivery); }, () => settle(entry, uncertain()))
      .catch(() => settle(entry, uncertain()))
      .finally(() => { submissions.delete(submittingInput); submitting = false; schedule(); });
    submissions.add(submittingInput);
  };
  const receive = (timeoutMs, requestName) => {
    if (closed) return Promise.resolve({ outcome: 'closed' });
    if (receiving) return Promise.resolve(errorResponse('receiveAlreadyPending', 'Only one receive call can be active.'));
    if (!inputs.length && timeoutMs === 0) return Promise.resolve({ outcome: 'timeout' });
    return new Promise((resolve) => {
      const waiter = { timer: null, resolve: (response) => {
        if (receiving === waiter) receiving = null;
        clearTimeout(waiter.timer); cancelReceives.delete(requestName); resolve(response);
      } };
      receiving = waiter; note('receiveWaiting', { requestId: requestName });
      cancelReceives.set(requestName, () => waiter.resolve({ outcome: 'closed' }));
      waiter.timer = setTimeout(() => {
        if (receiving !== waiter) return;
        waiter.resolve({ outcome: 'timeout' });
      }, timeoutMs);
      schedule();
    });
  };
  const close = (reason) => {
    if (!['completed', 'failed', 'cancelled', 'error'].includes(reason)) fail('bridgeInvalid', 'The bridge close reason is invalid.');
    if (closingPromise) return closingPromise;
    closed = true;
    if (receiving) { clearTimeout(receiving.timer); receiving.resolve({ outcome: 'closed' }); receiving = null; }
    abortSubmission.abort();
    for (const entry of inputs.splice(0)) settle(entry, unsubmitted());
    closingPromise = (async () => {
      await Promise.race([Promise.allSettled([...sends, ...submissions]), pause(500)]);
      for (const entry of pendingInputs) settle(entry, entry.attempted ? uncertain() : unsubmitted());
    })();
    return closingPromise;
  };
  return {
    async handleRequest(request, publishResponse = async () => {}, requestName = Symbol()) {
      let entry; let response; let ownsReceive = false;
      try {
        if (!fields(request, ['operation', 'text', 'timeoutMs'])) fail('bridgeRequestInvalid', 'The child tool request is invalid.');
        if (closed) response = closedResponse(request.operation);
        else if (request.operation === 'send') {
          if (Object.hasOwn(request, 'timeoutMs')) fail('invalidArguments', 'Send does not accept a receive timeout.');
          validateMessageText(request.text);
          const sending = Promise.resolve().then(() => emitParentMessage(request.text));
          sends.add(sending);
          try { await sending; response = { outcome: 'submitted' }; }
          finally { sends.delete(sending); }
        } else if (request.operation === 'receive') {
          if (Object.hasOwn(request, 'text')) fail('invalidArguments', 'Receive does not accept message text.');
          const timeoutMs = request.timeoutMs ?? LIMITS.receiveMs;
          if (!validTimeout(timeoutMs)) fail('invalidArguments', 'Receive timeout must be an integer from 0 to 1800000 milliseconds.');
          if (receiveActive) response = errorResponse('receiveAlreadyPending', 'Only one receive call can be active.');
          else {
            receiveActive = true; ownsReceive = true;
            ({ entry, ...response } = await receive(timeoutMs, requestName));
          }
        } else fail('invalidArguments', 'Use send or receive.');
        await publishResponse(response);
        if (entry) settle(entry, { status: 'submitted' });
        return response;
      } catch (error) {
        if (entry) settle(entry, uncertain());
        throw error;
      } finally {
        if (ownsReceive) { receiveActive = false; note('receiveReleased', { requestId: requestName }); }
      }
    },
    cancelRequest(requestName) { cancelReceives.get(requestName)?.(); },
    acceptInput(message) {
      if (!fields(message, ['id', 'text']) || !messageId(message.id)) fail('protocolInvalid', 'A parent input must have a valid ID and text.');
      validateMessageText(message.text);
      if (seenIds.has(message.id)) fail('protocolInvalid', 'A parent input ID cannot be reused.');
      seenIds.add(message.id);
      if (closed) return Promise.resolve(unsubmitted());
      return new Promise((resolve) => {
        const entry = { ...message, attempted: false, resolve };
        pendingInputs.add(entry); inputs.push(entry); schedule();
      });
    },
    hasPendingInput() { return pendingInputs.size > 0; },
    schedule,
    close,
  };
}

/** One adapter owns the scheduler; tools only publish private requests. */
export async function createChildBridge({ directory, deadlineAt, toolkit, emitParentMessage, submitInput, canSubmitInput } = {}) {
  if (!absolutePath(directory) || !(deadlineAt === null || epochMs(deadlineAt)) || !fields(toolkit, ['module', 'command', 'messageScript', 'mcpScript'])
      || ['module', 'command', 'messageScript', 'mcpScript'].some((key) => !absolutePath(toolkit[key])) || typeof emitParentMessage !== 'function'
      || (submitInput !== undefined && typeof submitInput !== 'function')
      || (canSubmitInput !== undefined && typeof canSubmitInput !== 'function')) fail('bridgeInvalid', 'The child bridge configuration is invalid.');
  for (const file of Object.values(toolkit)) await assertNoReparsePath(file, 'file');
  await verifyPrivatePath(path.dirname(directory), 'directory');
  await fs.mkdir(directory, { mode: 0o700 });
  await protectPrivatePath(directory, 'directory');
  const bindingFile = path.join(directory, 'binding.json');
  const binding = token();
  await atomicJson(bindingFile, { binding, pid: process.pid });
  let closed = false; let closingPromise; let scanning = false;
  const requests = new Set(); const active = new Set();
  const queue = createChildChannel({ emitParentMessage, submitInput, canSubmitInput, onError: () => { void close('error'); } });
  const handleRequest = async (name) => {
    const requestPath = path.join(directory, name);
    const responsePath = path.join(directory, name.replace('.request.json', '.response.json'));
    const requestId = name.slice(0, 32);
    try {
      await verifyPrivatePath(requestPath, 'file');
      const request = await readJson(requestPath, LIMITS.messageFrameBytes);
      if (!fields(request, ['binding', 'operation', 'text', 'timeoutMs']) || request.binding !== binding) fail('bridgeRequestInvalid', 'The child tool request is invalid.');
      note('requestVerified', { requestId, operation: request.operation });
      const { binding: _binding, ...operation } = request;
      await queue.handleRequest(operation, async (response) => {
        await atomicJson(responsePath, response);
        note('responsePublished', { requestId, operation: request.operation, outcome: response.outcome });
      }, requestId);
    } catch (error) {
      const code = /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error?.code ?? '') ? error.code : 'childToolFailed';
      note('requestFailed', { requestId, code });
      if (await fs.lstat(requestPath).then((stat) => stat.isFile(), () => false)) await atomicJson(responsePath, errorResponse(code, 'The child tool operation failed.')).catch(() => {});
    } finally { note('requestHandled', { requestId }); }
  };
  const scan = async () => {
    if (scanning || closed) return;
    scanning = true;
    try {
      const nodes = await fs.readdir(directory, { withFileTypes: true });
      for (const node of nodes) {
        if (!node.isFile() || !/^[a-f0-9]{32}\.request\.json$/.test(node.name) || requests.has(node.name)) continue;
        requests.add(node.name);
        const operation = handleRequest(node.name);
        active.add(operation);
        operation.finally(() => active.delete(operation));
      }
      // Completed tool requests are deleted by their caller. No history is kept.
      for (const name of requests) {
        try { await fs.lstat(path.join(directory, name)); }
        catch (error) { if (error.code === 'ENOENT') { queue.cancelRequest(name.slice(0, 32)); requests.delete(name); } else throw error; }
      }
      for (const node of nodes) {
        if (!node.isFile() || !/^[a-f0-9]{32}\.response\.json$/.test(node.name)) continue;
        const request = path.join(directory, node.name.replace('.response.json', '.request.json'));
        if (!await fs.lstat(request).then(() => true, (error) => { if (error.code === 'ENOENT') return false; throw error; })) {
          const requestId = node.name.slice(0, 32);
          note('orphanResponseRemoveStarted', { requestId, resourceKind: 'response' });
          await fs.unlink(path.join(directory, node.name)).catch((error) => {
            if (error.code === 'ENOENT') return;
            note('orphanResponseCleanupFailed', { requestId, resourceKind: 'response', osCode: error.code });
            throw error;
          });
          note('orphanResponseRemoved', { requestId, resourceKind: 'response' });
        }
      }
    } catch {
      void close('error');
    } finally { scanning = false; queue.schedule(); note('scanCompleted'); }
  };
  const interval = setInterval(() => void scan(), 10);
  const close = (reason) => {
    if (!['completed', 'failed', 'cancelled', 'error'].includes(reason)) fail('bridgeInvalid', 'The bridge close reason is invalid.');
    if (closingPromise) return closingPromise;
    closed = true; clearInterval(interval); clearTimeout(deadlineTimer);
    const closingQueue = queue.close(reason);
    closingPromise = (async () => {
      // A backend that ignores cancellation cannot keep tool or delivery promises open.
      await Promise.all([closingQueue, Promise.race([Promise.allSettled([...active]), pause(500)])]);
      // Publish closed responses for requests that raced with the last scan.
      const nodes = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
      for (const node of nodes) {
        if (node.isFile() && /^[a-f0-9]{32}\.request\.json$/.test(node.name) && !requests.has(node.name)) {
          const request = await readJson(path.join(directory, node.name), LIMITS.messageFrameBytes).catch(() => null);
          if (request?.binding === binding) await atomicJson(path.join(directory, node.name.replace('.request.json', '.response.json')), closedResponse(request.operation)).catch(() => {});
        }
      }
      await fs.unlink(bindingFile).catch(() => {});
      // Existing callers detect binding removal and return closed if their response failed.
      await pause(25);
      await verifyPrivatePath(directory, 'directory');
      await fs.rm(directory, { recursive: true, force: true });
      note('bridgeClosed');
    })();
    return closingPromise;
  };
  let deadlineTimer = null;
  if (deadlineAt !== null) {
    const tick = () => {
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) void close('cancelled');
      else deadlineTimer = setTimeout(tick, Math.min(remaining, 2147483647));
    };
    deadlineTimer = setTimeout(tick, Math.max(0, Math.min(deadlineAt - Date.now(), 2147483647)));
  }
  return {
    mcpServer: { command: toolkit.command, args: [toolkit.mcpScript, '--bridge', bindingFile] },
    script: { command: toolkit.command, args: [toolkit.messageScript, '--bridge', bindingFile] },
    acceptInput: queue.acceptInput,
    hasPendingInput: queue.hasPendingInput,
    close,
  };
}

/** Internal transport used by the generated script and MCP entrypoints. */
export async function invokeChildTool({ bindingFile, operation, text, timeoutMs, signal } = {}) {
  if (!absolutePath(bindingFile) || !['send', 'receive'].includes(operation)) fail('invalidArguments', 'Use the command generated by the child bridge.');
  if (operation === 'send') validateMessageText(text);
  else if (timeoutMs !== undefined && !validTimeout(timeoutMs)) fail('invalidArguments', 'Receive timeout must be an integer from 0 to 1800000 milliseconds.');
  note('toolStarted', { operation });
  const directory = path.dirname(bindingFile);
  let descriptor;
  try {
    await verifyPrivatePath(directory, 'directory'); note('toolDirectoryVerified', { operation });
    await verifyPrivatePath(bindingFile, 'file'); descriptor = await readJson(bindingFile, 4096);
  }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'pathMissing') return closedResponse(operation); throw error; }
  if (!fields(descriptor, ['binding', 'pid']) || !messageId(descriptor.binding) || !Number.isSafeInteger(descriptor.pid) || descriptor.pid <= 0) fail('bridgeInvalid', 'The child tool binding is invalid.');
  note('toolBindingVerified', { operation });
  const id = token(); const requestPath = path.join(directory, `${id}.request.json`); const responsePath = path.join(directory, `${id}.response.json`);
  try {
    await atomicJson(requestPath, { binding: descriptor.binding, operation, ...(operation === 'send' ? { text } : { timeoutMs: timeoutMs ?? LIMITS.receiveMs }) });
    note('toolRequestPublished', { operation, requestId: id });
    while (!signal?.aborted) {
      try { await verifyPrivatePath(responsePath, 'file'); const response = await readJson(responsePath, LIMITS.messageFrameBytes); note('toolResponseRead', { operation, requestId: id, outcome: response.outcome }); return response; }
      catch (error) { if (!['ENOENT', 'pathMissing'].includes(error.code)) throw error; }
      try { await fs.access(bindingFile); process.kill(descriptor.pid, 0); }
      catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) return closedResponse(operation); throw error; }
      await pause(10);
    }
    return closedResponse(operation);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'pathMissing') return closedResponse(operation);
    throw error;
  } finally {
    // The request marks caller ownership of the response. Release it last so
    // the orphan scanner cannot delete a response while its caller removes it.
    for (const resource of [responsePath, requestPath]) {
      const resourceKind = resource === requestPath ? 'request' : 'response';
      note('toolResourceRemoveStarted', { operation, requestId: id, resourceKind });
      await fs.unlink(resource).catch((error) => {
        if (error.code === 'ENOENT') return;
        note('toolResourceCleanupFailed', { operation, requestId: id, resourceKind, osCode: error.code });
        const failure = new RuntimeError('toolResourceCleanupFailed', `A child tool ${resourceKind} resource could not be removed (${error.code ?? 'unknown'}).`);
        failure.resourceKind = resourceKind; failure.osCode = error.code; failure.cause = error;
        throw failure;
      });
      note('toolResourceRemoved', { operation, requestId: id, resourceKind });
    }
  }
}

export function formatChildResponse(operation, response) {
  const command = operation === 'send' ? 'send_parent' : 'receive_parent';
  let output = `${command}: ${response.outcome}\n`;
  if (response.code) output += `code: ${response.code}\n`;
  if (response.message) output += `message: ${JSON.stringify(response.message)}\n`;
  if (response.outcome === 'received') {
    validateMessageText(response.text);
    let boundary;
    do { boundary = randomBytes(4).toString('hex'); } while (response.text.includes(boundary));
    output += `BEGIN_MESSAGE:${boundary}\n${response.text}\nEND_MESSAGE:${boundary}\n`;
  }
  return output;
}
