#!/usr/bin/env node
import path from 'node:path';
import { assertNativeSelectionReadable } from '../file-selection/scan-guard.mjs';
import { adapterMain, finalOutput, privateOutputPath } from './common.mjs';
import { oracleArguments } from './oracle-arguments.mjs';

export { oracleArguments } from './oracle-arguments.mjs';

export async function executeOracle(context) {
  const request = context.request;
  const outputFile = await privateOutputPath(request.runtime.directory, path.join(request.runtime.directory, 'oracle-answer.md'));
  const args = oracleArguments(request, outputFile);
  await assertNativeSelectionReadable(request.workspace, request.fileSelectors, { isCancelled: () => context.signal.aborted });
  if (context.signal.aborted) return { state: 'cancelled', code: context.errorCode, text: '' };
  const backend = await context.spawn('oracle', args);
  let stdoutBytes = 0;
  backend.child.stdout.on('data', (chunk) => {
    stdoutBytes += chunk.length;
    if (stdoutBytes > 8 * 1024 * 1024) context.abort('adapterDiagnosticTooLarge');
  });
  context.onStop = async () => { backend.child.kill('SIGINT'); await backend.end(); };
  await context.ready(false);
  if (context.signal.aborted) return { state: 'cancelled', code: context.errorCode, text: '' };
  context.generationStarted = null;
  await backend.write(request.prompt);
  await backend.end();
  await Promise.race([backend.done, context.stopped.promise]);
  let text = '';
  try { text = await finalOutput(outputFile); }
  catch (error) { return { state: 'unknown', text, code: error.code === 'adapterOutputTooLarge' ? error.code : 'serviceTerminalUnconfirmed' }; }
  if (context.signal.aborted || backend.exitCode !== 0 || !text.trim()) return { state: 'unknown', code: context.errorCode ?? 'serviceTerminalUnconfirmed', text };
  // Public --wait plus a fresh --write-output final answer and an actual
  // successful backend exit establish this CLI's service completion.
  context.generationStarted = true;
  return { state: 'completed', text };
}

adapterMain(import.meta.url, { mode: 'bundle', execute: executeOracle }, 'Oracle Adapter v5\nUsage: node oracle-v5.mjs\nReads one persistent v5 JSONL connection. Uses PATH oracle --prompt - --wait --write-output and raw --file selectors.\nCommunication is unsupported. Normal engine configuration applies. No default execution deadline or automatic retry.\n');
