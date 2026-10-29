import path from 'node:path';
import { validateSelectors } from '../file-selection/contracts.mjs';

export const LIMITS = Object.freeze({
  taskBytes: 262144, instructionBytes: 262144,
  promptBytes: 524352, requestBytes: 8388608,
  outputBytes: 4194304, logBytes: 8388608,
  resultBytes: 33554432,
  messageBytes: 4096, messageFrameBytes: 32768, controlFrameBytes: 4096,
  deliveryFrameBytes: 16384, receiveMs: 600000, waitMs: 600000, maximumWaitMs: 1800000,
});

export const RUNTIME_KEYS = Object.freeze(['subagentCommands']);
export const STATES = Object.freeze(['completed', 'failed', 'cancelled', 'unknown']);
export const cleanString = (value) => typeof value === 'string' && value.trim().length > 0 && !/[\u0000-\u001f\u007f]/u.test(value);
export const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
export const text = (value) => typeof value === 'string' && !value.includes('\0') && value.isWellFormed();
export const fields = (value, allowed) => object(value) && Object.keys(value).every((key) => allowed.includes(key));
export const identifier = (value) => cleanString(value) && value.isWellFormed() && [...value].length <= 256 && !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value);
export const code = (value) => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(value);
export const messageId = (value) => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
export const runId = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{11}$/.test(value);
export const label = (value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value);
export const epochMs = (value) => Number.isSafeInteger(value) && value >= 0;
export const absolutePath = (value) => text(value) && value.length > 0 && path.isAbsolute(value) && path.normalize(value) === value;
const requiredFields = (value, required, optional = []) => fields(value, [...required, ...optional]) && required.every((key) => Object.hasOwn(value, key));
const byteLength = (value) => Buffer.byteLength(value, 'utf8');

export function validateMessageText(value) {
  if (!text(value) || !value.trim()) fail('messageInvalid', 'Message text must be nonempty Unicode text without NUL.');
  if (byteLength(value) > LIMITS.messageBytes) fail('messageTooLarge', 'Message text exceeds the 4096-byte limit.');
  return value;
}

export function validateDelivery(value) {
  if (!requiredFields(value, ['status'], ['code', 'message']) || !['submitted', 'notSubmitted', 'unknown'].includes(value.status)
      || (Object.hasOwn(value, 'code') && !code(value.code))
      || (value.status !== 'submitted' && !code(value.code))
      || (Object.hasOwn(value, 'message') && (!text(value.message) || byteLength(value.message) > LIMITS.messageBytes))) {
    fail('protocolInvalid', 'The input delivery classification is invalid.');
  }
  return value;
}

export function validateCommunication(value) {
  if (requiredFields(value, ['status']) && ['disabled', 'unsupported'].includes(value.status)) return value;
  if (!requiredFields(value, ['status', 'transport', 'passiveDelivery']) || value.status !== 'enabled'
      || !['mcp', 'command'].includes(value.transport) || !['in-turn', 'turn-boundary', 'none'].includes(value.passiveDelivery)) {
    fail('protocolInvalid', 'The communication descriptor is invalid.');
  }
  return value;
}

export function validateInitialization(value, { ready = false } = {}) {
  if (!requiredFields(value, ['environment', 'capabilities'])
      || !(requiredFields(value.environment, ['status']) && value.environment.status === 'available'
        || requiredFields(value.environment, ['status', 'code']) && value.environment.status === 'unavailable' && code(value.environment.code))
      || !fields(value.capabilities, ['communication'])
      || ready && (value.environment.status !== 'available' || !Object.hasOwn(value.capabilities, 'communication'))) {
    fail('protocolInvalid', 'The initialization descriptor is invalid.');
  }
  if (Object.hasOwn(value.capabilities, 'communication')) validateCommunication(value.capabilities.communication);
  if (value.environment.status === 'unavailable' && value.capabilities.communication?.status === 'enabled') fail('protocolInvalid', 'An unavailable environment cannot enable communication.');
  return value;
}

export function validateDiagnostics(value) {
  if (!Array.isArray(value) || value.length > 64 || value.some((entry) => !requiredFields(entry, ['code', 'message'], ['field'])
      || !code(entry.code) || !text(entry.message) || !entry.message.trim() || byteLength(entry.message) > 2048
      || Object.hasOwn(entry, 'field') && (!cleanString(entry.field) || !entry.field.isWellFormed() || byteLength(entry.field) > 512))) {
    fail('protocolInvalid', 'The initialization diagnostics are invalid.');
  }
  return value;
}

/** The shared wire shape does not establish a backend's terminal state. */
export function validateRequest(request) {
  const required = ['protocolVersion', 'type', 'run', 'execution', 'mode', 'workspace', 'prompt', 'args', 'communication', 'runtime'];
  if (!requiredFields(request, required, ['fileSelectors', 'fileResolver', 'codex', 'permissionMode']) || request.protocolVersion !== 5 || request.type !== 'start' || !['workspace', 'bundle'].includes(request.mode) || typeof request.communication !== 'boolean'
      || Object.hasOwn(request, 'permissionMode') && !['default', 'auto', 'full-access'].includes(request.permissionMode)) fail('protocolInvalid', 'Use a mode-correct Adapter v5 start frame.');
  if (!requiredFields(request.run, ['id', 'name', 'deadlineAt']) || !runId(request.run.id) || !label(request.run.name) || !(request.run.deadlineAt === null || epochMs(request.run.deadlineAt))) fail('protocolInvalid', 'The Adapter v5 run identity or deadline is invalid.');
  if (!requiredFields(request.execution, ['executor'], ['model', 'reasoningEffort']) || !identifier(request.execution.executor) || ['model', 'reasoningEffort'].some((key) => Object.hasOwn(request.execution, key) && !identifier(request.execution[key]))) fail('protocolInvalid', 'The Adapter v5 execution selection is invalid.');
  if (Object.hasOwn(request, 'codex') && (!requiredFields(request.codex, ['cliSource', 'bypassHookTrust'], ['profile'])
      || !['auto', 'cli', 'app'].includes(request.codex.cliSource) || typeof request.codex.bypassHookTrust !== 'boolean'
      || Object.hasOwn(request.codex, 'profile') && !identifier(request.codex.profile))) fail('protocolInvalid', 'The Codex adapter configuration is invalid.');
  if (!absolutePath(request.workspace) || !text(request.prompt) || !request.prompt.trim() || byteLength(request.prompt) > LIMITS.promptBytes || !Array.isArray(request.args) || request.args.some((value) => !text(value))) fail('protocolInvalid', 'The Adapter v5 workspace, prompt, or args is invalid.');
  if (!requiredFields(request.runtime, ['directory', 'toolkit']) || !absolutePath(request.runtime.directory) || !requiredFields(request.runtime.toolkit, ['module', 'command', 'messageScript', 'mcpScript']) || Object.values(request.runtime.toolkit).some((value) => !absolutePath(value))) fail('protocolInvalid', 'The Adapter v5 private runtime or installed toolkit is invalid.');
  if (request.mode === 'workspace') {
    if (Object.hasOwn(request, 'fileSelectors') || Object.hasOwn(request, 'fileResolver')) fail('protocolInvalid', 'Workspace requests must omit all file selection fields.');
  } else {
    if (!Array.isArray(request.fileSelectors) || request.fileSelectors.some((value) => !text(value)) || !requiredFields(request.fileResolver, ['command', 'args']) || !absolutePath(request.fileResolver.command) || !Array.isArray(request.fileResolver.args) || request.fileResolver.args.length !== 1 || !absolutePath(request.fileResolver.args[0])) fail('protocolInvalid', 'Bundle requests require raw fileSelectors and the installed fileResolver.');
    try { validateSelectors(request.fileSelectors); } catch { fail('protocolInvalid', 'The bundle fileSelectors contain an invalid selection value.'); }
  }
  if (byteLength(JSON.stringify(request)) > LIMITS.requestBytes) fail('protocolTooLarge', 'The Adapter v5 start frame exceeds the 8 MiB limit.');
  return request;
}

export function validateResult(result) {
  const required = ['protocolVersion', 'type', 'state', 'generationStarted', 'backendExitCode', 'text'];
  if (!requiredFields(result, required, ['code', 'message', 'sessionId', 'model', 'remoteStopConfirmed', 'diagnostics', 'initialization']) || result.protocolVersion !== 5 || result.type !== 'result' || !STATES.includes(result.state) || ![true, false, null].includes(result.generationStarted) || !(result.backendExitCode === null || Number.isSafeInteger(result.backendExitCode)) || !text(result.text) || byteLength(result.text) > LIMITS.outputBytes
      || (Object.hasOwn(result, 'code') && !code(result.code))
      || (result.state !== 'completed' && !code(result.code))
      || (Object.hasOwn(result, 'message') && (!text(result.message) || byteLength(result.message) > LIMITS.messageBytes))
      || ['sessionId', 'model'].some((key) => Object.hasOwn(result, key) && !identifier(result[key]))
      || (Object.hasOwn(result, 'remoteStopConfirmed') && typeof result.remoteStopConfirmed !== 'boolean')
      || (result.state === 'completed' && (result.generationStarted !== true || result.backendExitCode !== 0 || !result.text.trim()))
      || byteLength(JSON.stringify(result)) > LIMITS.resultBytes) fail('adapterResultInvalid', 'The Adapter v5 result is missing, invalid, or exceeds its limit.');
  if (Object.hasOwn(result, 'diagnostics')) validateDiagnostics(result.diagnostics);
  if (Object.hasOwn(result, 'initialization')) {
    validateInitialization(result.initialization);
    if (result.initialization.environment.status === 'unavailable' && (result.state !== 'failed' || result.generationStarted !== false)) fail('protocolInvalid', 'An unavailable environment requires a failed initialization without model input.');
  }
  return result;
}

export class RuntimeError extends Error {
  constructor(code, message, recoveryActions = []) {
    super(message); this.name = 'RuntimeError'; this.code = code; this.recoveryActions = recoveryActions;
  }
}
export function fail(code, message, recoveryActions = []) { throw new RuntimeError(code, message, recoveryActions); }
export function safeError(error) {
  return {
    ok: false, state: 'failed', generationStarted: false,
    code: error?.code && /^[A-Za-z][A-Za-z0-9]*$/.test(error.code) ? error.code : 'runtimeFailed',
    message: error instanceof RuntimeError ? error.message : 'The runtime operation failed. Check the safe diagnostics.',
    recoveryActions: Array.isArray(error?.recoveryActions) ? error.recoveryActions : [],
  };
}
export function redact(text, environment = {}, secretValues = []) {
  let result = String(text);
  const values = [...secretValues, ...Object.entries(environment).filter(([key]) => /KEY|TOKEN|SECRET|PASSWORD|AUTH/i.test(key)).map(([, value]) => value)];
  const needles = new Set();
  for (const value of values) {
    if (typeof value !== 'string' || !value) continue;
    needles.add(value);
    needles.add(JSON.stringify(value).slice(1, -1));
  }
  if (needles.size) {
    // Match the complete value first, including its JSON string representation.
    // One replacement pass does not rewrite the inserted redaction marker.
    const pattern = [...needles].sort((left, right) => right.length - left.length)
      .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    result = result.replace(new RegExp(pattern, 'g'), '[redacted]');
  }
  return result.replace(/\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|AKIA[A-Z0-9]{16})\b/g, '[redacted]')
    .replace(/("(?:access_token|refresh_token|id_token|api_key|password)"\s*:\s*")[^"\n]+/gi, '$1[redacted]')
    .replace(/(authorization\s*[:=]\s*(?:bearer\s+)?)[^\s"']+/gi, '$1[redacted]');
}
