export const LIMITS = Object.freeze({
  files: 128, fileBytes: 1048576, materialBytes: 8388608,
  taskBytes: 262144, instructionBytes: 262144,
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
export function redact(text, environment = {}) {
  let result = String(text);
  for (const [key, value] of Object.entries(environment)) {
    if (typeof value === 'string' && value && /KEY|TOKEN|SECRET|PASSWORD|AUTH/i.test(key)) result = result.split(value).join('[redacted]');
  }
  return result.replace(/\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|AKIA[A-Z0-9]{16})\b/g, '[redacted]')
    .replace(/("(?:access_token|refresh_token|id_token|api_key|password)"\s*:\s*")[^"\n]+/gi, '$1[redacted]')
    .replace(/(authorization\s*[:=]\s*(?:bearer\s+)?)[^\s"']+/gi, '$1[redacted]');
}
