#!/usr/bin/env node
import { LIMITS } from '../runtime/contracts.mjs';
import { assertNativeSelectionReadable } from '../file-selection/scan-guard.mjs';
import { LIMITS as SELECTION_LIMITS } from '../file-selection/contracts.mjs';
import { adapterMain, executeAdapter, finalOutput } from './common.mjs';
import { oracleArguments } from './oracle-arguments.mjs';

export { oracleArguments } from './oracle-arguments.mjs';

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
