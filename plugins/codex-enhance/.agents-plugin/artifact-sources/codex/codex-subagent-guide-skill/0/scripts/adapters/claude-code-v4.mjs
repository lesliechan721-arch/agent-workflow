#!/usr/bin/env node
import { LIMITS } from '../runtime/contracts.mjs';
import { textFromBytes } from '../runtime/files.mjs';
import { adapterMain, checkArguments, executeAdapter, rejectOption } from './common.mjs';

export function claudeArguments(request) {
  checkArguments(request.args, {
    owned: ['--print', '-p', '--output-format', '--input-format', '--continue', '-c', '--resume', '-r', '--fork-session', '--from-pr', '--cloud', '--remote', '--environment', '--teleport', '--worktree', '-w', '--tmux', '--help', '-h', '--version', '-v'],
    commands: ['agents', 'auth', 'doctor', 'install', 'mcp', 'plugin', 'plugins', 'setup-token', 'update', 'upgrade'],
    short: { '-d': 'value', '-n': 'value' },
    values: ['--agent', '--agents', '--append-system-prompt', '--debug-file', '--effort', '--fallback-model', '--json-schema', '--max-budget-usd', '--model', '--name', '--permission-mode', '--plugin-dir', '--remote-control-session-name-prefix', '--session-id', '--setting-sources', '--settings', '--system-prompt', '--system-prompt-file', '--append-system-prompt-file'],
    variadic: ['--add-dir', '--allowedTools', '--allowed-tools', '--disallowedTools', '--disallowed-tools', '--betas', '--file', '--mcp-config', '--tools'],
    booleans: ['--allow-dangerously-skip-permissions', '--bare', '--brief', '--chrome', '--dangerously-skip-permissions', '--disable-slash-commands', '--exclude-dynamic-system-prompt-sections', '--ide', '--include-hook-events', '--include-partial-messages', '--mcp-debug', '--no-chrome', '--no-session-persistence', '--replay-user-messages', '--strict-mcp-config', '--verbose'],
    onOption(option) {
      if (request.execution.model !== undefined && option === '--model') rejectOption(option);
      if (request.execution.reasoningEffort !== undefined && option === '--effort') rejectOption(option);
    },
  });
  const args = ['--print', '--output-format', 'json', ...request.args];
  if (request.execution.model !== undefined) args.push('--model', request.execution.model);
  if (request.execution.reasoningEffort !== undefined) args.push('--effort', request.execution.reasoningEffort);
  return args;
}

const failureTypes = new Set(['error_max_turns', 'error_during_execution', 'error_max_budget_usd', 'error_max_structured_output_retries']);
export function claudeResult(_request, run) {
  let value;
  try { value = JSON.parse(textFromBytes(run.stdout)); }
  catch { return { state: 'unknown', generationStarted: null, text: '', code: 'backendOutputInvalid' }; }
  if (!value || Array.isArray(value) || value.type !== 'result' || typeof value.is_error !== 'boolean' || !Number.isSafeInteger(value.num_turns) || value.num_turns < 0 || typeof value.session_id !== 'string' || !value.session_id) return { state: 'unknown', generationStarted: null, text: '', code: 'serviceTerminalUnconfirmed' };
  const common = { sessionId: value.session_id, generationStarted: value.num_turns > 0 ? true : null, text: '' };
  if (failureTypes.has(value.subtype) && value.is_error === true) {
    return { ...common, state: 'failed', code: 'backendFailed', ...(Array.isArray(value.errors) && value.errors.every((item) => typeof item === 'string') ? { message: value.errors.join('\n').slice(0, 8192) } : {}) };
  }
  const text = typeof value.result === 'string' ? value.result : '';
  if (Buffer.byteLength(text) > LIMITS.outputBytes) return { ...common, state: 'unknown', code: 'adapterOutputTooLarge' };
  if (value.subtype !== 'success' || value.is_error || run.code !== 0 || !text.trim()) return { ...common, text, state: 'unknown', code: 'serviceTerminalConflict' };
  return { ...common, state: 'completed', generationStarted: true, text };
}

export function executeClaude(request, environment = process.env, options) {
  return executeAdapter(request, environment, { command: 'claude', mode: 'workspace', arguments: claudeArguments, result: claudeResult }, options);
}

adapterMain(import.meta.url, executeClaude, `Claude Code Adapter v4\nUsage: node claude-code-v4.mjs < request.json\nUses PATH claude --print, one stdin prompt and its final JSON result.\nRequires the Guide runner's private directory, result path and ownership marker.\nLimits: ${LIMITS.requestBytes} request bytes, ${LIMITS.outputBytes} answer bytes, ${LIMITS.logBytes} diagnostic bytes, ${LIMITS.deadlineMs} ms.\nNormal backend configuration applies. No automatic retries or confirmed remote cancellation. Exit 0=completed/help; 1=other outcomes.\n`);
