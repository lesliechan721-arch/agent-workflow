#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { RUNTIME_KEYS, fail, safeError } from './runtime/contracts.mjs';
import { selectExecution } from './runtime/plan.mjs';
import { prepareRun } from './runtime/runner.mjs';
import { readInputFile } from './runtime/files.mjs';
import { storeContext, scanExpired } from './runtime/store.mjs';
import { startRun, sendInput, waitRuns, readResult, stopRun } from './runtime/commands.mjs';
import { writeChunk, diagnostic } from './runtime/output.mjs';

export const HELP = `Guide external task runtime (Adapter v5)
Usage:
  start --executor KEY (--prompt TEXT | --prompt-file PATH)
    [--name NAME] [--workspace DIR] [--instructions-file FILE] [--file SELECTOR]...
    [--model MODEL] [--reasoning-effort EFFORT] [--deadline-ms N]
  send --run HANDLE (--text TEXT | --text-file PATH)
  wait --run HANDLE [--run HANDLE]... [--timeout-ms N]
  result --run HANDLE [--output-file PATH]
  stop --run HANDLE

start observes initialization for up to 10 seconds. Reuse a starting or failed handle with wait/result/stop.
NAME: 1-64 ASCII letters, digits, dot, underscore, or hyphen; start with a letter or digit.
Operations accept handles. Native execution uses the host tools directly.
There is no default execution deadline. --deadline-ms is a positive safe integer.
wait accepts 1-16 distinct handles. Its default window is 600000 ms; range: 0-1800000.
wait returns unread events, first ready, or first terminal evidence. Closing alone does not return.
Messages: nonblank valid UTF-8 without NUL, at most 4096 bytes each.
Task and instructions: 256 KiB each. Final text: 4 MiB. Input text is preserved.
Task and message input must use text or a normal file. '-' and stdin input are unsupported.
Relative file paths use the caller directory. Workspace defaults to that directory.
Workspace rejects --file. Bundle preserves selectors and AW file selection protocol v1.
Backend configuration, authentication, permissions, and approvals remain in effect.
wait consumes selected complete events before output. result consumes only after complete output.
wait and normal result: stdout plus stderr at most 8192 bytes. Large reports require --output-file.
File export creates a new file without overwriting. Write or close failure retains unread messages.
A complete export reports its absolute path, UTF-8 byte count, and consumption result.
The fixed final result remains readable for one hour from its terminal time; reads do not extend it.
Serialize wait/result consumers for each run. There is no replay, resume, or automatic resubmission.
stop waits at most 30 seconds and stops only proven owned processes. Local exit is not remote cancellation.
Ordinary commands collect expired, stopped resources. There is no public cleanup command.
Exit: 0 completed (including wait timeout and failed-task reads), 1 operation failed, 2 invalid input.
Legacy --export, --details, run, poll, preview, and Adapter v4 are unsupported.
`;

const options = {
  executor: { type: 'string' }, prompt: { type: 'string' }, 'prompt-file': { type: 'string' }, name: { type: 'string' },
  workspace: { type: 'string' }, 'instructions-file': { type: 'string' }, file: { type: 'string', multiple: true },
  model: { type: 'string' }, 'reasoning-effort': { type: 'string' }, 'deadline-ms': { type: 'string' },
  run: { type: 'string', multiple: true }, text: { type: 'string' }, 'text-file': { type: 'string' }, 'timeout-ms': { type: 'string' }, 'output-file': { type: 'string' },
};
const allowed = {
  start: ['executor', 'prompt', 'prompt-file', 'name', 'workspace', 'instructions-file', 'file', 'model', 'reasoning-effort', 'deadline-ms'],
  send: ['run', 'text', 'text-file'], wait: ['run', 'timeout-ms'], result: ['run', 'output-file'], stop: ['run'],
};
function integer(value, name, minimum, maximum) {
  if (!/^(0|[1-9][0-9]*)$/.test(value ?? '') || !Number.isSafeInteger(Number(value)) || Number(value) < minimum || Number(value) > maximum) fail('argumentsInvalid', `${name} must be an integer from ${minimum} to ${maximum}.`);
  return Number(value);
}
export function parseCommand(argv) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) return { operation: 'help' };
  let parsed;
  try { parsed = parseArgs({ args: argv, allowPositionals: true, strict: true, tokens: true, options }); }
  catch { fail('argumentsInvalid', 'An argument is invalid or unsupported. Use --help for the current commands.'); }
  const [operation, ...rest] = parsed.positionals;
  if (!Object.hasOwn(allowed, operation) || rest.length) fail('operationUnsupported', 'Use start, send, wait, result, or stop.');
  const supplied = parsed.tokens.filter((token) => token.kind === 'option').map((token) => token.name);
  if (supplied.some((key) => !allowed[operation].includes(key)) || supplied.some((key) => !['run', 'file'].includes(key) && supplied.filter((item) => item === key).length !== 1)) fail('argumentsInvalid', 'The command contains an unsupported or repeated argument.');
  const value = parsed.values;
  if (operation === 'start') {
    if (!value.executor || Object.hasOwn(value, 'prompt') === Object.hasOwn(value, 'prompt-file') || value.prompt === '-' || value['prompt-file'] === '-' || value['prompt-file'] === '') fail('argumentsInvalid', 'Supply --executor and exactly one of --prompt TEXT or --prompt-file PATH.');
    if (value.name !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value.name)) fail('nameInvalid', 'Use 1-64 ASCII letters, digits, dot, underscore, or hyphen; start with a letter or digit.');
    return { operation, executor: value.executor, prompt: value.prompt, promptFile: value['prompt-file'], name: value.name, workspace: value.workspace,
      instructionsFile: value['instructions-file'], files: value.file ?? [], model: value.model, reasoningEffort: value['reasoning-effort'],
      ...(value['deadline-ms'] === undefined ? {} : { deadlineMs: integer(value['deadline-ms'], '--deadline-ms', 1, Number.MAX_SAFE_INTEGER - Date.now()) }) };
  }
  const runs = value.run ?? [];
  if (!runs.length || runs.some((handle) => !/^[\x21-\x7e]{1,256}$/.test(handle))) fail('argumentsInvalid', 'Supply a nonempty ASCII run handle of at most 256 bytes.');
  if (operation !== 'wait' && runs.length !== 1) fail('argumentsInvalid', 'This command requires exactly one --run.');
  if (new Set(runs).size > 16) fail('argumentsInvalid', 'wait accepts at most 16 distinct runs.');
  if (operation === 'send' && (Object.hasOwn(value, 'text') === Object.hasOwn(value, 'text-file') || value.text === '-' || value['text-file'] === '-' || value['text-file'] === '')) fail('argumentsInvalid', 'Supply exactly one of --text TEXT or --text-file PATH.');
  if (value['output-file'] !== undefined && (!value['output-file'] || value['output-file'] === '-' || value['output-file'].includes('\0') || !value['output-file'].isWellFormed())) fail('argumentsInvalid', 'Supply a normal output file path.');
  return { operation, runs: [...new Set(runs)], text: value.text, textFile: value['text-file'], outputFile: value['output-file'],
    ...(operation === 'wait' ? { timeoutMs: value['timeout-ms'] === undefined ? 600000 : integer(value['timeout-ms'], '--timeout-ms', 0, 1800000) } : {}) };
}

async function installedReader() {
  try { return (await import('./aw-runtime-config.mjs')).readRuntimeConfig; }
  catch { fail('installedRuntimeMissing', 'The AW runtime helper is missing. Sync or reinstall and run from the installed Guide.', ['sync', 'reinstall']); }
}
export async function executeCommand(request, dependencies = {}) {
  if (request.operation === 'help') return { text: HELP, exitCode: 0 };
  const callerCwd = dependencies.callerCwd ?? process.cwd();
  dependencies = { ...dependencies, callerCwd };
  if (request.outputFile !== undefined) request = { ...request, outputFile: path.resolve(callerCwd, request.outputFile) };
  let prepared;
  if (request.operation === 'start') {
    const reader = dependencies.readRuntimeConfig ?? await installedReader();
    const snapshot = await reader({ from: import.meta.url, keys: RUNTIME_KEYS });
    prepared = await prepareRun(selectExecution(snapshot, request), request, dependencies);
  }
  if (request.operation === 'send') {
    if ((request.text !== undefined) === (request.textFile !== undefined) || request.text === '-' || request.textFile === '-') fail('argumentsInvalid', 'Supply exactly one text or file input.');
    const text = request.textFile === undefined ? request.text : await readInputFile(request.textFile, 4096, 'messageTooLarge', dependencies.callerCwd ?? process.cwd());
    if (typeof text !== 'string' || !text.isWellFormed() || !text.trim() || text.includes('\0')) fail('messageInvalid', 'Supply nonblank UTF-8 text without NUL.');
    if (Buffer.byteLength(text) > 4096) fail('messageTooLarge', 'The message exceeds the 4096 byte limit.');
    request = { ...request, text };
  }
  const context = await storeContext(dependencies);
  context.scanFailed = await scanExpired(context);
  if (request.operation === 'start') return startRun(context, prepared, request);
  if (request.operation === 'send') return sendInput(context, request);
  if (request.operation === 'wait') return waitRuns(context, request);
  if (request.operation === 'result') return readResult(context, request);
  return stopRun(context, request);
}

async function main() {
  process.umask(0o077);
  let outputError;
  process.stdout.on('error', (error) => { outputError = error; });
  const response = await executeCommand(parseCommand(process.argv.slice(2)));
  try {
    await writeChunk(process.stdout, response.text);
    await new Promise((resolve) => setImmediate(resolve));
    if (outputError) throw outputError;
  } catch {
    await writeChunk(process.stderr, diagnostic('resultOutputFailed', 'The command output could not be written. A completed file export may already have consumed its messages.')).catch(() => {});
    process.exitCode = 1; return;
  }
  try { await response.afterOutput?.(); }
  catch (error) {
    const safe = safeError(error);
    await writeChunk(process.stderr, diagnostic(safe.code, safe.message)).catch(() => {});
    process.exitCode = 1; return;
  }
  if (response.diagnostic) await writeChunk(process.stderr, response.diagnostic);
  process.exitCode = response.exitCode;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch(async (error) => {
  const safe = safeError(error);
  await writeChunk(process.stderr, diagnostic(safe.code, safe.message)).catch(() => {});
  const invalidInput = new Set(['argumentsInvalid', 'operationUnsupported', 'nameInvalid', 'executorInvalid', 'executorUnknown', 'nativeUnsupported', 'parameterInvalid', 'registryInvalid', 'environmentInvalid', 'environmentConflict', 'promptInvalid', 'taskTooLarge', 'inputEmpty', 'inputFileInvalid', 'messageInvalid', 'messageTooLarge', 'instructionsInvalid', 'instructionsTooLarge', 'binaryUnsupported', 'filesNotAllowedInWorkspace', 'fileSelectionInputInvalid', 'fileSelectionLimitExceeded']);
  process.exitCode = invalidInput.has(safe.code) ? 2 : 1;
});
