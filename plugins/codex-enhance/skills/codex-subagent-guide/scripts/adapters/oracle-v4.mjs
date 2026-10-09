#!/usr/bin/env node
import { LIMITS, fail } from '../runtime/contracts.mjs';
import { assertNativeSelectionReadable } from '../file-selection/scan-guard.mjs';
import { LIMITS as SELECTION_LIMITS } from '../file-selection/contracts.mjs';
import { adapterMain, checkArguments, executeAdapter, finalOutput, rejectOption } from './common.mjs';

export function oracleArguments(request, outputFile, environment = {}) {
  let engine;
  let browser = false;
  checkArguments(request.args, {
    owned: ['--prompt', '-p', '--message', '--file', '-f', '--include', '--files', '--path', '--paths', '--wait', '--no-wait', '--write-output', '--models', '--followup', '--followup-model', '--browser-follow-up', '--browser-tab', '--session', '--status', '--exec-session', '--dry-run', '--preview', '--route', '--preflight', '--render', '--render-markdown', '--copy', '--copy-markdown', '--debug-help', '--help', '-h', '--version', '-V'],
    commands: ['serve', 'project-sources', 'bridge', 'tui', 'doctor', 'docs', 'session', 'status', 'restart'],
    short: { '-m': 'value', '-e': 'value', '-s': 'value', '-v': 'boolean' },
    booleans: ['--files-report', '--verbose', '--notify', '--no-notify', '--notify-sound', '--no-notify-sound', '--background', '--no-background', '--zombie-last-activity', '--perf-trace', '--render-plain', '--write-artifacts', '--allow-partial', '--verbose-render', '--no-azure', '--browser', '--browser-attach-running', '--browser-cookie-sync', '--browser-manual-login', '--browser-capture-provider-native', '--no-browser-capture-provider-native', '--browser-inline-files', '--browser-bundle-files', '--gemini-show-thoughts', '--no-gemini-fallback', '--force'],
    onOption(option, value) {
      if (request.execution.model !== undefined && ['--model', '-m'].includes(option)) rejectOption(option);
      if (request.execution.reasoningEffort !== undefined && option === '--reasoning-effort') rejectOption(option);
      if (['--engine', '--mode', '-e'].includes(option)) engine = value;
      if (option === '--browser') browser = true;
    },
  });
  if (request.execution.reasoningEffort !== undefined && (browser || engine === 'browser' || (engine === undefined && environment.ORACLE_ENGINE?.trim().toLowerCase() === 'browser'))) fail('parameterUnavailable', 'Oracle reasoningEffort requires the API engine. Browser thinking time is a different setting.');
  const args = ['--prompt', '-', '--wait', '--write-output', outputFile, ...request.args];
  if (request.execution.model !== undefined) args.push('--model', request.execution.model);
  if (request.execution.reasoningEffort !== undefined) args.push('--reasoning-effort', request.execution.reasoningEffort);
  for (const selector of request.fileSelectors) args.push('--file', selector);
  return args;
}

export async function oracleResult(_request, run, outputFile) {
  let text = '';
  try { text = await finalOutput(outputFile); }
  catch (error) { return { state: 'unknown', generationStarted: null, text: '', code: error.code === 'adapterOutputTooLarge' ? error.code : 'serviceTerminalUnconfirmed' }; }
  // --wait keeps this CLI attached. Its public --write-output contract exports
  // the final assistant answer only after service completion. A fresh export
  // and exit 0 are both required; stdout acceptance/log messages are ignored.
  if (run.code !== 0 || !text.trim()) return { state: 'unknown', generationStarted: null, text, code: 'serviceTerminalUnconfirmed' };
  return { state: 'completed', generationStarted: true, text };
}

export function executeOracle(request, environment = process.env, options) {
  return executeAdapter(request, environment, {
    command: 'oracle', mode: 'bundle', arguments: oracleArguments, result: oracleResult,
    preflight: (value, control) => assertNativeSelectionReadable(value.workspace, value.fileSelectors, { isCancelled: () => control.interrupted }),
  }, options);
}

adapterMain(import.meta.url, executeOracle, `Oracle Adapter v4\nUsage: node oracle-v4.mjs < request.json\nUses PATH oracle --prompt - --wait --write-output and raw repeated --file selectors.\nThe read-only scan guard checks suppressed I/O failures; Oracle alone selects files. No helper, projection, or private Oracle import is used.\nRequires the Guide runner's private directory, result path and ownership marker.\nLimits: ${LIMITS.requestBytes} request bytes, ${LIMITS.outputBytes} answer bytes, ${LIMITS.logBytes} diagnostic bytes, ${LIMITS.deadlineMs} ms.\nScan guard: ${SELECTION_LIMITS.selectors} selectors, ${SELECTION_LIMITS.patterns} patterns, ${SELECTION_LIMITS.entries} directory entries, ${SELECTION_LIMITS.operations} metadata operations, ${SELECTION_LIMITS.ignoreFileBytes} bytes per ignore file, ${SELECTION_LIMITS.ignoreTotalBytes} ignore bytes total, ${SELECTION_LIMITS.durationMs} ms.\nEngine and normal backend configuration apply. No automatic retries or confirmed remote cancellation. Exit 0=completed/help; 1=other outcomes.\n`);
