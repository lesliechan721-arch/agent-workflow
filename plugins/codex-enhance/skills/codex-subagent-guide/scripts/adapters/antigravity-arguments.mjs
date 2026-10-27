import { fail } from '../runtime/contracts.mjs';
import { rejectOption } from './common.mjs';

const owned = new Set([
  '--input-format', '--output-format', '--print', '-p', '--prompt', '--prompt-interactive', '-i',
  '--continue', '-c', '--conversation', '--project', '--new-project', '--remote-control',
  '--print-timeout', '--cwd', '--workdir', '--gemini_dir', '--app_data_dir',
  '--help', '-h', '--version', '-v', '-V', '--', '-',
]);
const booleans = new Set(['--sandbox', '--dangerously-skip-permissions', '--disable-slash-commands']);
const values = new Set(['--model', '--effort', '--agent', '--mode', '--add-dir', '--json-schema', '--log-file']);
const efforts = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

/** The public agy 1.4.7 options; unverified options cannot change AW controls. */
export function checkAntigravityArguments(request) {
  const seen = new Set();
  for (let index = 0; index < request.args.length; index++) {
    const argument = request.args[index];
    const equals = argument.indexOf('=');
    const option = equals < 0 ? argument : argument.slice(0, equals);
    if (owned.has(option)) rejectOption(option);
    if (!option.startsWith('--')) fail('adapterArgumentConflict', 'Antigravity args must contain backend options and their values, not a command or prompt.');
    if (!booleans.has(option) && !values.has(option)) fail('parameterUnavailable', 'This Antigravity option has no verified CLI contract. Use a documented backend option.');
    if (option !== '--add-dir' && seen.has(option)) fail('adapterArgumentConflict', 'Keep one value for each Antigravity option.');
    seen.add(option);
    if (booleans.has(option)) {
      if (equals >= 0 && !['true', 'false'].includes(argument.slice(equals + 1))) fail('parameterUnavailable', 'Antigravity boolean options accept true or false.');
      continue;
    }
    const value = equals < 0 ? request.args[++index] : argument.slice(equals + 1);
    if (typeof value !== 'string' || !value.trim() || equals < 0 && value.startsWith('-')) fail('parameterUnavailable', 'This Antigravity option requires a nonempty value.');
    if (option === '--model' && request.execution.model !== undefined || option === '--effort' && request.execution.reasoningEffort !== undefined) rejectOption(option);
    if (option === '--effort' && !efforts.has(value)) fail('parameterUnavailable', 'Antigravity effort must be low, medium, high, xhigh, or max.');
    if (option === '--mode' && !['accept-edits', 'auto', 'plan'].includes(value)) fail('parameterUnavailable', 'Antigravity mode must be accept-edits, auto, or plan.');
  }
  if (request.execution.reasoningEffort !== undefined && !efforts.has(request.execution.reasoningEffort)) fail('parameterUnavailable', 'Antigravity effort must be low, medium, high, xhigh, or max.');
}

export function antigravityArguments(request) {
  checkAntigravityArguments(request);
  const args = ['--input-format', 'stream-json', '--output-format', 'stream-json', '--print-timeout', '0', ...request.args];
  if (request.execution.model !== undefined) args.push('--model', request.execution.model);
  if (request.execution.reasoningEffort !== undefined) args.push('--effort', request.execution.reasoningEffort);
  return args;
}
