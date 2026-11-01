import {
  LIMITS, fields, fail, messageId, identifier, validateDelivery, validateMessageText,
  validateRequest, validateResult, validateInitialization, validateDiagnostics,
} from './contracts.mjs';
import { isDeepStrictEqual } from 'node:util';

const required = (value, keys, optional = []) => fields(value, [...keys, ...optional]) && keys.every((key) => Object.hasOwn(value, key));
const invalid = (message) => fail('protocolInvalid', message);
const frameLimit = (type) => type === 'start' ? LIMITS.requestBytes : type === 'result' ? LIMITS.resultBytes : type === 'message' ? LIMITS.messageFrameBytes : type === 'delivery' ? LIMITS.deliveryFrameBytes : LIMITS.controlFrameBytes;

/** direction identifies the sender: worker inputs or adapter events. */
export function validateFrame(frame, direction) {
  if (!['worker', 'adapter'].includes(direction)) invalid('The frame direction must be worker or adapter.');
  if (!fields(frame, Object.keys(frame ?? {})) || frame.protocolVersion !== 5 || typeof frame.type !== 'string') invalid('Use an Adapter v5 object frame.');
  let maximum;
  if (direction === 'worker' && frame.type === 'start') {
    validateRequest(frame); maximum = LIMITS.requestBytes;
  } else if (frame.type === 'message') {
    const keys = direction === 'worker' ? ['protocolVersion', 'type', 'id', 'text'] : ['protocolVersion', 'type', 'text'];
    if (!required(frame, keys) || (direction === 'worker' && !messageId(frame.id))) invalid('The message frame identity or fields are invalid.');
    validateMessageText(frame.text); maximum = LIMITS.messageFrameBytes;
  } else if (direction === 'worker' && frame.type === 'stop') {
    if (!required(frame, ['protocolVersion', 'type', 'reason']) || !['requested', 'deadline', 'channelError'].includes(frame.reason)) invalid('The stop frame is invalid.');
    maximum = LIMITS.controlFrameBytes;
  } else if (direction === 'adapter' && frame.type === 'ready') {
    if (!required(frame, ['protocolVersion', 'type', 'initialization'], ['diagnostics'])) invalid('The ready frame is invalid.');
    validateInitialization(frame.initialization, { ready: true });
    if (Object.hasOwn(frame, 'diagnostics')) validateDiagnostics(frame.diagnostics);
    maximum = LIMITS.controlFrameBytes;
  } else if (direction === 'adapter' && frame.type === 'session') {
    if (!required(frame, ['protocolVersion', 'type', 'sessionId']) || !identifier(frame.sessionId)) invalid('The session frame is invalid.');
    maximum = LIMITS.controlFrameBytes;
  } else if (direction === 'adapter' && frame.type === 'delivery') {
    if (!required(frame, ['protocolVersion', 'type', 'id', 'status'], ['code', 'message']) || !messageId(frame.id)) invalid('The delivery frame is invalid.');
    const { protocolVersion, type, id, ...delivery } = frame;
    validateDelivery(delivery); maximum = LIMITS.deliveryFrameBytes;
  } else if (direction === 'adapter' && frame.type === 'closing') {
    if (!required(frame, ['protocolVersion', 'type', 'reason']) || !['completed', 'failed', 'cancelled', 'error'].includes(frame.reason)) invalid('The closing frame is invalid.');
    maximum = LIMITS.controlFrameBytes;
  } else if (direction === 'adapter' && frame.type === 'result') {
    validateResult(frame); maximum = LIMITS.resultBytes;
  } else invalid('The frame type is not valid for this sender.');
  if (Buffer.byteLength(JSON.stringify(frame)) > maximum) fail('protocolTooLarge', 'The frame exceeds its encoded byte limit.');
  return frame;
}

/** One connection owns one state. Validate before committing each frame. */
export function createProtocolState() {
  let started = false; let ready = false; let closing = false; let result = false;
  let initialization = null; let mode; let requestedCommunication; let requestedResume; let expectedSession; let sessionId = null; let resume = null; let stopReason = null;
  const seenInputs = new Set(); const awaitingDelivery = new Set();
  const checkResume = (value) => {
    const capability = value.capabilities.resume;
    if (!capability) return;
    if (!requestedResume && capability.status !== 'disabled' || requestedResume && capability.status === 'disabled') invalid('Initialization must preserve the requested resume setting.');
    if (sessionId && capability.status !== 'enabled') invalid('A bound session requires resume enabled.');
  };
  const checkCommunication = (value) => {
    checkResume(value);
    const communication = value.capabilities.communication;
    if (!communication) return;
    if (mode === 'bundle' && communication.status === 'enabled') invalid('Bundle runs cannot enable communication.');
    if (!requestedCommunication && communication.status !== 'disabled' || requestedCommunication && communication.status === 'disabled') invalid('Initialization must preserve the requested communication setting.');
  };
  return {
    get phase() { return result ? 'terminal' : closing ? 'closing' : ready ? 'running' : started ? 'starting' : 'initial'; },
    get initialization() { return initialization; },
    get communication() { return initialization?.capabilities.communication ?? null; },
    get resume() { return resume; },
    get sessionId() { return sessionId; },
    get stopReason() { return stopReason; },
    acceptWorker(frame) {
      validateFrame(frame, 'worker');
      if (result) invalid('Task input is not allowed after the result.');
      if (!started) {
        if (frame.type !== 'start') invalid('The first worker frame must be start.');
        started = true; mode = frame.mode; requestedCommunication = frame.communication; requestedResume = frame.resume; expectedSession = frame.sessionId; return frame;
      }
      if (frame.type === 'start') invalid('Start must occur exactly once.');
      if (frame.type === 'stop') { stopReason ??= frame.reason; return frame; }
      if (!ready || initialization.capabilities.communication.status !== 'enabled') invalid('Parent messages require ready with communication enabled.');
      if (seenInputs.has(frame.id)) invalid('Parent message IDs must be unique in this connection.');
      seenInputs.add(frame.id); awaitingDelivery.add(frame.id); return frame;
    },
    acceptAdapter(frame) {
      validateFrame(frame, 'adapter');
      if (!started || result) invalid('Adapter events require start and cannot follow result.');
      if (frame.type === 'session') {
        if (closing || !requestedResume || resume && resume.status !== 'enabled') invalid('Session binding requires an open resume-enabled run.');
        if (sessionId && sessionId !== frame.sessionId || expectedSession && expectedSession !== frame.sessionId) invalid('The session cannot change within a run or on resume.');
        sessionId = frame.sessionId; resume = { status: 'enabled' };
      } else if (frame.type === 'ready') {
        if (ready || closing) invalid('Ready must occur once before closing.');
        checkCommunication(frame.initialization);
        ready = true; initialization = structuredClone(frame.initialization); resume = structuredClone(initialization.capabilities.resume);
      } else if (frame.type === 'result') {
        if (frame.sessionId && (sessionId && sessionId !== frame.sessionId || expectedSession && expectedSession !== frame.sessionId)) invalid('The result session must preserve the session binding.');
        if (!ready) {
          const provenUnsubmitted = ['failed', 'cancelled'].includes(frame.state) && frame.generationStarted === false;
          const uncertain = frame.state === 'unknown' && frame.generationStarted === null;
          if (!provenUnsubmitted && !uncertain) invalid('An initialization result must preserve actual submission evidence.');
        } else if (!closing) invalid('A result must follow closing.');
        if (frame.initialization) {
          checkCommunication(frame.initialization);
          if (ready && !isDeepStrictEqual(initialization, frame.initialization)) invalid('The result must preserve the published initialization descriptor.');
          if (!ready) {
            initialization = structuredClone(frame.initialization);
            if (initialization.capabilities.resume) resume = structuredClone(initialization.capabilities.resume);
          }
        }
        result = true;
      } else if (!ready) invalid('The first adapter event must be ready or an initialization result.');
      else if (frame.type === 'closing') {
        if (closing) invalid('Closing must occur exactly once.');
        closing = true;
      } else if (frame.type === 'message') {
        if (initialization.capabilities.communication.status !== 'enabled' || closing) invalid('Child messages require an open communication-enabled run.');
      } else if (frame.type === 'delivery') {
        if (initialization.capabilities.communication.status !== 'enabled' || !awaitingDelivery.delete(frame.id)) invalid('Delivery must identify one pending parent input exactly once.');
      }
      return frame;
    },
  };
}

/** Byte framing is independent from task handlers and output backpressure. */
export function createFrameDecoder({ direction, onFrame, onError } = {}) {
  if (typeof onFrame !== 'function') invalid('A frame consumer is required.');
  let buffer = Buffer.allocUnsafe(4096); let length = 0; let ended = false;
  const consume = () => {
    let bytes = buffer.subarray(0, length);
    length = 0;
    if (bytes.at(-1) === 13) bytes = bytes.subarray(0, -1);
    if (!bytes.length) invalid('Empty JSONL frames are not allowed.');
    let frame;
    try { frame = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)); }
    catch { invalid('The JSONL frame must contain valid UTF-8 JSON without a BOM.'); }
    validateFrame(frame, direction);
    if (bytes.length > frameLimit(frame.type)) fail('protocolTooLarge', 'The JSONL frame exceeds its encoded byte limit.');
    const pending = onFrame(frame);
    if (pending && typeof pending.then === 'function') {
      // Callers with asynchronous handlers must provide an error sink.
      if (onError) pending.catch(onError);
      else pending.catch((error) => queueMicrotask(() => { throw error; }));
    }
  };
  return {
    push(chunk) {
      if (ended) invalid('JSONL input has already ended.');
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      let offset = 0;
      while (offset < bytes.length) {
        const newline = bytes.indexOf(10, offset);
        const end = newline < 0 ? bytes.length : newline;
        const part = bytes.subarray(offset, end);
        const nextLength = length + part.length;
        if (nextLength > LIMITS.resultBytes + 1) fail('protocolTooLarge', 'The unfinished JSONL frame exceeds its byte limit.');
        if (nextLength > buffer.length) {
          const expanded = Buffer.allocUnsafe(Math.min(LIMITS.resultBytes + 1, Math.max(buffer.length * 2, nextLength)));
          buffer.copy(expanded, 0, 0, length); buffer = expanded;
        }
        part.copy(buffer, length); length = nextLength;
        if (newline < 0) break;
        consume(); offset = newline + 1;
      }
    },
    end() {
      if (ended) return;
      ended = true;
      if (length) invalid('JSONL input ended before the final LF.');
    },
  };
}

/** A complete line is submitted once; write callbacks include backpressure. */
export function createFrameWriter(writable, { direction } = {}) {
  let tail = Promise.resolve(); let closedError = null;
  const pending = new Set();
  const close = (error = new Error('The protocol output is closed.')) => {
    if (closedError) return;
    closedError = error;
    for (const reject of pending) reject(error);
    pending.clear();
  };
  writable.on('error', close);
  writable.on('close', () => close());
  return {
    write(frame) {
      validateFrame(frame, direction);
      const line = Buffer.from(`${JSON.stringify(frame)}\n`);
      const operation = tail.then(() => new Promise((resolve, reject) => {
        if (closedError || writable.destroyed || writable.writableEnded) { reject(closedError ?? new Error('The protocol output is closed.')); return; }
        pending.add(reject);
        writable.write(line, (error) => { pending.delete(reject); if (error) reject(error); else resolve(); });
      }));
      tail = operation.catch(() => {});
      return operation;
    },
    close,
  };
}
