#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { RUNTIME_KEYS, LIMITS, fail, safeError } from './runtime/contracts.mjs';
import { selectExecution } from './runtime/plan.mjs';
import { prepareRun } from './runtime/runner.mjs';
import { readInputFile } from './runtime/files.mjs';
import { storeContext, launchExpiryScan } from './runtime/store.mjs';
import { startRun, sendInput, waitRuns, readResult, stopRun } from './runtime/commands.mjs';
import { writeChunk, diagnostic } from './runtime/output.mjs';

export const HELP = `Guide external task runtime (Adapter v5)
Usage: <command> [options]
  start   Start an external task.
  send    Send input to a running task or resume a stopped task.
  wait    Wait for unread events or a terminal result.
  result  Read or export a fixed final result.
  stop    Stop a task's owned local processes.

Use <command> --help for parameters, defaults, and examples.
Use --diagnostics on a command to include routine and previously reported diagnostics.
Errors and warnings remain visible by default.
Exit: 0 completed, 1 operation failed or startup pending, 2 invalid input.
`;

const commandHelp = {
  start: `Start an external task.
Usage: start --executor KEY (--prompt TEXT | --prompt-file PATH)
    [--name NAME] [--workspace DIR] [--instructions-file FILE] [--file SELECTOR]...
    [--model MODEL] [--reasoning-effort EFFORT] [--deadline-ms N] [--diagnostics]

--executor KEY selects the exact installed external executor; native uses host tools.
--workspace DIR defaults to the caller directory. Relative paths use that directory.
--instructions-file FILE supplies role instructions. Task and instructions: 256 KiB each.
--model MODEL and --reasoning-effort EFFORT override backend defaults when supported.
--deadline-ms N is a positive safe integer. There is no default execution deadline.
--file SELECTOR may repeat in bundle mode. Workspace mode rejects --file.
NAME: 1-64 ASCII letters, digits, dot, underscore, or hyphen; start with a letter or digit.
Input must be text or a regular UTF-8 file; '-' and stdin are unsupported.
start observes initialization for up to 10 seconds. Reuse a starting or failed handle
with wait/result/stop; do not submit the task again. start consumes no messages or final.
Backend configuration, authentication, permissions, and approvals remain in effect.
--diagnostics includes routine initialization information and startupNotReady.
Example: start --executor KEY --prompt-file task.txt
`,
  send: `Send input to a running task with communication=true, or resume a stopped task.
Usage: send --run HANDLE (--text TEXT | --text-file PATH) [--diagnostics]

Input must be nonblank valid UTF-8 without NUL, at most 24576 bytes.
--text-file PATH must be a regular file. '-' and stdin are unsupported.
Use --text-file for long messages; shell and operating system argument limits still apply.
queued confirms local queueing, not backend delivery. delivery=unknown must not be resent automatically.
Stopped tasks require resume=true, a saved session, and confirmed local stopping.
Resume keeps the run and its original execution configuration, and replaces its previous result.
Resume returns started, starting, or start_failed. Continue with the same handle.
--diagnostics enables routine diagnostic information for this command.
Example: send --run HANDLE --text "Additional task context."
`,
  wait: `Wait for unread events, first ready, or first terminal evidence.
Usage: wait --run HANDLE [--run HANDLE]... [--timeout-ms N] [--diagnostics]

Accepts 1-16 distinct handles. --timeout-ms defaults to 600000; range: 0-1800000.
Closing alone does not return. timeout means the task may still be running.
more=true: drain with --timeout-ms 0, then resume long waiting.
deferred: the final was not delivered; read it with result, or result --output-file PATH.
Selected events are consumed before output. Serialize wait/result reads for each run.
stdout plus stderr: at most 32768 UTF-8 bytes. Messages have no replay guarantee.
--diagnostics includes routine and previously reported initialization diagnostics.
Example: wait --run HANDLE
`,
  result: `Read or export a fixed final result without generating again.
Usage: result --run HANDLE [--output-file PATH] [--diagnostics]

--output-file PATH creates a new file without overwriting; relative paths use the caller directory.
Ordinary stdout plus stderr: at most 32768 UTF-8 bytes. Larger reports require --output-file.
Files are complete reports; exports report path, UTF-8 bytes, and consumed=true|false.
Messages are consumed only after complete output or a successful file write and close.
The fixed final uses the current retention setting, normally 24 hours from termination.
Reads do not extend retention. A resumed execution replaces the previous final.
Serialize wait/result reads for each run. Consumed messages have no replay guarantee.
--diagnostics includes routine and previously reported diagnostics, including in exports.
Example: result --run HANDLE --diagnostics --output-file report.txt
`,
  stop: `Stop a task's proven owned local processes.
Usage: stop --run HANDLE [--diagnostics]

Waits at most 30 seconds. stopped confirms local stopping only.
remote_stop_confirmed=true|false|unknown reports separate remote cancellation evidence.
Use result to read retained final evidence. An unknown remote status does not confirm cancellation.
--diagnostics enables routine diagnostic information for this command.
Example: stop --run HANDLE
`,
};

const options = {
  help: { type: 'boolean', short: 'h' }, diagnostics: { type: 'boolean' },
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
  const helpHint = Object.hasOwn(allowed, argv[0]) ? `Use ${argv[0]} --help for this command.` : 'Use --help for the current commands.';
  let parsed;
  try { parsed = parseArgs({ args: argv, allowPositionals: true, strict: true, tokens: true, options }); }
  catch { fail('argumentsInvalid', `An argument is invalid or unsupported. ${helpHint}`); }
  const [operation, ...rest] = parsed.positionals;
  if (operation === undefined && parsed.values.help && parsed.tokens.length === 1) return { operation: 'help' };
  if (!Object.hasOwn(allowed, operation) || rest.length) fail('operationUnsupported', 'Use start, send, wait, result, or stop.');
  const supplied = parsed.tokens.filter((token) => token.kind === 'option').map((token) => token.name);
  if (supplied.some((key) => !['help', 'diagnostics', ...allowed[operation]].includes(key)) || supplied.some((key) => !['run', 'file'].includes(key) && supplied.filter((item) => item === key).length !== 1)) fail('argumentsInvalid', `The command contains an unsupported or repeated argument. ${helpHint}`);
  const value = parsed.values;
  if (value.help) return { operation: 'help', topic: operation };
  if (operation === 'start') {
    if (!value.executor || Object.hasOwn(value, 'prompt') === Object.hasOwn(value, 'prompt-file') || value.prompt === '-' || value['prompt-file'] === '-' || value['prompt-file'] === '') fail('argumentsInvalid', `Supply --executor and exactly one of --prompt TEXT or --prompt-file PATH. ${helpHint}`);
    if (value.name !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value.name)) fail('nameInvalid', 'Use 1-64 ASCII letters, digits, dot, underscore, or hyphen; start with a letter or digit.');
    return { operation, showDiagnostics: value.diagnostics === true, executor: value.executor, prompt: value.prompt, promptFile: value['prompt-file'], name: value.name, workspace: value.workspace,
      instructionsFile: value['instructions-file'], files: value.file ?? [], model: value.model, reasoningEffort: value['reasoning-effort'],
      ...(value['deadline-ms'] === undefined ? {} : { deadlineMs: integer(value['deadline-ms'], '--deadline-ms', 1, Number.MAX_SAFE_INTEGER - Date.now()) }) };
  }
  const runs = value.run ?? [];
  if (!runs.length || runs.some((handle) => !/^[\x21-\x7e]{1,256}$/.test(handle))) fail('argumentsInvalid', `Supply a nonempty ASCII run handle of at most 256 bytes. ${helpHint}`);
  if (operation !== 'wait' && runs.length !== 1) fail('argumentsInvalid', 'This command requires exactly one --run.');
  if (new Set(runs).size > 16) fail('argumentsInvalid', 'wait accepts at most 16 distinct runs.');
  if (operation === 'send' && (Object.hasOwn(value, 'text') === Object.hasOwn(value, 'text-file') || value.text === '-' || value['text-file'] === '-' || value['text-file'] === '')) fail('argumentsInvalid', 'Supply exactly one of --text TEXT or --text-file PATH.');
  if (value['output-file'] !== undefined && (!value['output-file'] || value['output-file'] === '-' || value['output-file'].includes('\0') || !value['output-file'].isWellFormed())) fail('argumentsInvalid', 'Supply a normal output file path.');
  return { operation, showDiagnostics: value.diagnostics === true, runs: [...new Set(runs)], text: value.text, textFile: value['text-file'], outputFile: value['output-file'],
    ...(operation === 'wait' ? { timeoutMs: value['timeout-ms'] === undefined ? 600000 : integer(value['timeout-ms'], '--timeout-ms', 0, 1800000) } : {}) };
}

async function installedReader() {
  try { return (await import('./aw-runtime-config.mjs')).readRuntimeConfig; }
  catch { fail('installedRuntimeMissing', 'The AW runtime helper is missing. Sync or reinstall and run from the installed Guide.', ['sync', 'reinstall']); }
}
export async function executeCommand(request, dependencies = {}) {
  if (request.operation === 'help') return { text: commandHelp[request.topic] ?? HELP, exitCode: 0 };
  const callerCwd = dependencies.callerCwd ?? process.cwd();
  dependencies = { ...dependencies, callerCwd };
  if (request.outputFile !== undefined) request = { ...request, outputFile: path.resolve(callerCwd, request.outputFile) };
  if (request.operation === 'send') {
    if ((request.text !== undefined) === (request.textFile !== undefined) || request.text === '-' || request.textFile === '-') fail('argumentsInvalid', 'Supply exactly one text or file input.');
    const text = request.textFile === undefined ? request.text : await readInputFile(request.textFile, LIMITS.messageBodyBytes, 'messageTooLarge', dependencies.callerCwd ?? process.cwd());
    if (typeof text !== 'string' || !text.isWellFormed() || !text.trim() || text.includes('\0')) fail('messageInvalid', 'Supply nonblank UTF-8 text without NUL.');
    if (Buffer.byteLength(text) > LIMITS.messageBodyBytes) fail('messageTooLarge', 'The message exceeds the 24576 byte limit.');
    request = { ...request, text };
  }
  let snapshot;
  try {
    const reader = dependencies.readRuntimeConfig ?? await installedReader();
    snapshot = await reader({ from: import.meta.url, keys: RUNTIME_KEYS });
  } catch (error) { if (request.operation === 'start') throw error; }
  let prepared;
  if (request.operation === 'start') prepared = await prepareRun(selectExecution(snapshot, request), request, dependencies);
  const retention = snapshot?.effectiveValues?.subagentRetentionHours;
  const context = await storeContext({ ...dependencies, retentionHours: snapshot ? retention === undefined ? 24 : retention : null,
    sourceIdentity: snapshot?.installedIdentity });
  launchExpiryScan(context);
  if (request.operation === 'start') return startRun(context, prepared, request);
  if (request.operation === 'send') return sendInput(context, request, { ...dependencies, runtimeSnapshot: snapshot });
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
