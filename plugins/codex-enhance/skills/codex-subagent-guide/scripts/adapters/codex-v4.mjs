#!/usr/bin/env node
import { LIMITS } from '../runtime/contracts.mjs';
import { textFromBytes } from '../runtime/files.mjs';
import { adapterMain, checkArguments, executeAdapter, finalOutput, rejectOption } from './common.mjs';

function configKey(value) {
  const key = String(value ?? '').split('=', 1)[0].trim();
  if (key.startsWith('"')) { try { return JSON.parse(key); } catch { return key; } }
  return key.replace(/^'(.*)'$/s, '$1');
}

export function checkCodexArguments(request, owned = []) {
  checkArguments(request.args, {
    owned: ['--json', '--output-last-message', '-o', '--cd', '-C', '--worktree', '--help', '-h', '--version', '-V', ...owned],
    commands: ['exec', 'resume', 'fork', 'review', 'help'],
    short: { '-c': 'value', '-m': 'value', '-p': 'value', '-s': 'value', '-i': 'value' },
    values: ['--config', '--model', '--profile', '--sandbox', '--enable', '--disable', '--local-provider', '--add-dir', '--thread-source', '--cyber-access-program', '--output-schema', '--color'],
    variadic: ['--image', '-i'],
    booleans: ['--oss', '--approve-for-me', '--dangerously-bypass-approvals-and-sandbox', '--dangerously-bypass-hook-trust', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--strict-config'],
    onOption(option, value) {
      if (request.execution.model !== undefined && (['--model', '-m'].includes(option) || (['--config', '-c'].includes(option) && configKey(value) === 'model'))) rejectOption(option);
      if (request.execution.reasoningEffort !== undefined && ['--config', '-c'].includes(option) && configKey(value) === 'model_reasoning_effort') rejectOption(option);
    },
  });
}

export function codexArguments(request, outputFile) {
  checkCodexArguments(request);
  const args = ['exec', '--json', '--output-last-message', outputFile, ...request.args];
  if (request.execution.model !== undefined) args.push('--model', request.execution.model);
  if (request.execution.reasoningEffort !== undefined) args.push('--config', `model_reasoning_effort=${JSON.stringify(request.execution.reasoningEffort)}`);
  return [...args, '-'];
}

export async function codexResult(_request, run, outputFile) {
  let events;
  try { events = textFromBytes(run.stdout).split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line)); }
  catch { return { state: 'unknown', generationStarted: null, code: 'backendOutputInvalid', text: '' }; }
  const threads = events.filter((event) => event?.type === 'thread.started');
  const starts = events.filter((event) => event?.type === 'turn.started');
  const terminals = events.filter((event) => ['turn.completed', 'turn.failed'].includes(event?.type));
  const common = { generationStarted: starts.length ? true : null, text: '' };
  if (threads.length === 1 && typeof threads[0].thread_id === 'string' && threads[0].thread_id) common.sessionId = threads[0].thread_id;
  if (threads.length !== 1 || !common.sessionId || starts.length > 1 || terminals.length !== 1) return { ...common, state: 'unknown', code: 'serviceTerminalUnconfirmed' };
  const terminal = terminals[0];
  if (terminal.type === 'turn.failed') {
    if (events.indexOf(terminal) !== events.length - 1) return { ...common, state: 'unknown', code: 'serviceTerminalConflict' };
    return { ...common, state: 'failed', code: 'backendFailed', ...(typeof terminal.error?.message === 'string' ? { message: terminal.error.message } : {}) };
  }
  const messages = events.filter((event) => event?.type === 'item.completed' && event.item?.type === 'agent_message');
  let text = '';
  try { text = await finalOutput(outputFile); }
  catch (error) { return { ...common, state: 'unknown', code: error.code === 'adapterOutputTooLarge' ? error.code : 'backendFinalMessageMissing' }; }
  const message = messages.at(-1)?.item?.text;
  const usage = terminal.usage;
  const usageValid = usage && ['input_tokens', 'output_tokens'].every((key) => Number.isSafeInteger(usage[key]) && usage[key] >= 0);
  if (run.code !== 0 || starts.length !== 1 || events.indexOf(terminal) !== events.length - 1 || !usageValid || !text.trim() || typeof message !== 'string' || message.trimEnd() !== text.trimEnd()) return { ...common, text, state: 'unknown', code: 'serviceTerminalConflict' };
  return { ...common, state: 'completed', generationStarted: true, text };
}

export function executeCodex(request, environment = process.env, options) {
  return executeAdapter(request, environment, { command: 'codex', mode: 'workspace', arguments: codexArguments, result: codexResult }, options);
}

adapterMain(import.meta.url, executeCodex, `Codex Adapter v4\nUsage: node codex-v4.mjs < request.json\nUses PATH codex exec, one stdin prompt, JSONL terminal events and a private final-message file.\nRequires the Guide runner's private directory, result path and ownership marker.\nLimits: ${LIMITS.requestBytes} request bytes, ${LIMITS.outputBytes} answer bytes, ${LIMITS.logBytes} diagnostic bytes, ${LIMITS.deadlineMs} ms.\nNo automatic retries or confirmed remote cancellation. Exit 0=completed/help; 1=other outcomes.\n`);
