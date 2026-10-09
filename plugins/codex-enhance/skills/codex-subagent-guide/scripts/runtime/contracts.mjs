import path from 'node:path';
import { validateSelectors } from '../file-selection/contracts.mjs';

export const LIMITS = Object.freeze({
  taskBytes: 262144, instructionBytes: 262144,
  promptBytes: 524352, requestBytes: 8388608,
  outputBytes: 4194304, logBytes: 8388608, deadlineMs: 1800000,
  resultBytes: 33554432,
});

export const PROFILE_KEYS = Object.freeze([
  'simpleTaskProfile', 'generalTaskProfile', 'complexTaskProfile', 'advancedTaskProfile',
  'quickProfile', 'standardProfile', 'deepProfile', 'advisorProfile',
  'advisorDesignProfile', 'advisorDebugProfile', 'advisorReviewProfile',
]);
export const RUNTIME_KEYS = Object.freeze([...PROFILE_KEYS, 'subagentCommands']);
export const STATES = Object.freeze(['completed', 'failed', 'cancelled', 'unknown']);
export const cleanString = (value) => typeof value === 'string' && value.trim().length > 0 && !/[\u0000-\u001f\u007f]/u.test(value);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value) => typeof value === 'string' && !value.includes('\0') && value.isWellFormed();
const fields = (value, allowed) => object(value) && Object.keys(value).every((key) => allowed.includes(key));

/** The shared wire shape does not establish a backend's terminal state. */
export function validateRequest(request) {
  const required = ['protocolVersion', 'execution', 'mode', 'workspace', 'prompt', 'args'];
  if (!fields(request, [...required, 'fileSelectors', 'fileResolver']) || required.some((key) => !Object.hasOwn(request, key)) || request.protocolVersion !== 4 || !['workspace', 'bundle'].includes(request.mode)) fail('protocolInvalid', 'Use a mode-correct Adapter v4 request.');
  if (!fields(request.execution, ['profile', 'executor', 'model', 'reasoningEffort']) || !cleanString(request.execution.profile) || !cleanString(request.execution.executor) || ['model', 'reasoningEffort'].some((key) => Object.hasOwn(request.execution, key) && !cleanString(request.execution[key]))) fail('protocolInvalid', 'The Adapter v4 execution selection is invalid.');
  if (!text(request.workspace) || !path.isAbsolute(request.workspace) || !text(request.prompt) || !request.prompt.trim() || Buffer.byteLength(request.prompt) > LIMITS.promptBytes || !Array.isArray(request.args) || request.args.some((value) => !text(value))) fail('protocolInvalid', 'The Adapter v4 workspace, prompt, or args is invalid.');
  if (request.mode === 'workspace') {
    if (Object.hasOwn(request, 'fileSelectors') || Object.hasOwn(request, 'fileResolver')) fail('protocolInvalid', 'Workspace requests must omit all file selection fields.');
  } else {
    if (!Array.isArray(request.fileSelectors) || request.fileSelectors.some((value) => !text(value)) || !fields(request.fileResolver, ['command', 'args']) || !cleanString(request.fileResolver.command) || !path.isAbsolute(request.fileResolver.command) || !Array.isArray(request.fileResolver.args) || request.fileResolver.args.length !== 1 || !cleanString(request.fileResolver.args[0]) || !path.isAbsolute(request.fileResolver.args[0])) fail('protocolInvalid', 'Bundle requests require raw fileSelectors and the installed fileResolver.');
    try { validateSelectors(request.fileSelectors); } catch { fail('protocolInvalid', 'The bundle fileSelectors contain an invalid selection value.'); }
  }
  if (Buffer.byteLength(JSON.stringify(request)) > LIMITS.requestBytes) fail('protocolTooLarge', 'The Adapter v4 request exceeds the 8 MiB limit.');
  return request;
}

export function validateResult(result) {
  const required = ['protocolVersion', 'state', 'generationStarted', 'backendExitCode', 'text'];
  if (!fields(result, [...required, 'code', 'message', 'sessionId', 'model', 'remoteStopConfirmed']) || required.some((key) => !Object.hasOwn(result, key)) || result.protocolVersion !== 4 || !STATES.includes(result.state) || ![true, false, null].includes(result.generationStarted) || !(result.backendExitCode === null || Number.isSafeInteger(result.backendExitCode)) || !text(result.text) || Buffer.byteLength(result.text) > LIMITS.outputBytes || ['code', 'message', 'sessionId', 'model'].some((key) => Object.hasOwn(result, key) && !text(result[key])) || (Object.hasOwn(result, 'remoteStopConfirmed') && typeof result.remoteStopConfirmed !== 'boolean')) fail('adapterResultInvalid', 'The Adapter v4 result is missing, invalid, or exceeds its limit.');
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
