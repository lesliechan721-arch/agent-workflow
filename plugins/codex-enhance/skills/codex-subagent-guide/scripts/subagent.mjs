#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { RUNTIME_KEYS, fail, safeError } from './runtime/contracts.mjs';
import { selectExecution } from './runtime/plan.mjs';
import { prepareRun } from './runtime/runner.mjs';
import { readStdin } from './runtime/files.mjs';
import { storeContext, scanExpired } from './runtime/store.mjs';
import { startRun, sendInput, waitRuns, readResult, stopRun } from './runtime/commands.mjs';
import { writeChunk, diagnostic } from './runtime/output.mjs';

export const HELP = `Guide external task runtime (Adapter v5)
Usage:
  node scripts/subagent.mjs start --profile KEY --prompt TEXT|-
    [--name NAME] [--workspace DIR] [--instructions-file FILE] [--file SELECTOR]...
    [--model MODEL] [--reasoning-effort EFFORT] [--deadline-ms N]
  node scripts/subagent.mjs send --run HANDLE --text TEXT|-
  node scripts/subagent.mjs wait --run HANDLE [--run HANDLE]... [--timeout-ms N]
  node scripts/subagent.mjs result --run HANDLE [--export]
  node scripts/subagent.mjs stop --run HANDLE

start returns a handle and communication: true, false, or pending. Initialization waits up to 10 seconds.
NAME: 1-64 ASCII letters, digits, dot, underscore, or hyphen; first character is a letter or digit.
Operations accept handles, never names. Names can repeat. Native profiles use the host tools directly.
There is no default execution deadline. --deadline-ms is a positive safe integer, fixed at worker start.
wait accepts 1-16 distinct handles. Its default window is 600000 ms; range: 0-1800000.
wait returns on any change. A zero window is for immediate checks or draining more: true.
Messages: nonblank valid UTF-8 without NUL, at most 4096 bytes each, with no cumulative quota.
--prompt - and --text - read noninteractive UTF-8 stdin until EOF. Original text is preserved.
Task and instructions: 256 KiB each. Final text: 4 MiB. Workspace defaults to the current directory.
Workspace rejects --file. Bundle preserves each raw selector and AW file selection protocol v1.
Backend configuration, authentication, permissions, and approvals remain in effect.
wait consumes complete events once. result reads every unread message and the fixed final result.
Only the final result can be read again, for one hour from its fixed terminal time; reads do not extend it.
wait and default result: stdout plus stderr at most 8192 bytes. A large result requires --export.
--export writes the same complete report to stdout without the display limit. It takes no path.
Choose a file, pipe, or other destination that accepts the complete output before calling --export.
The calling tool can still truncate output. Consumed process messages cannot be recovered.
result consumes messages only after successful stdout output. A consume failure can leave duplicates.
Serialize wait/result consumers for each run. There is no history, replay, resume, or automatic resubmission.
stop waits at most 30 seconds and stops only proven owned processes. Local exit is not remote cancellation.
Ordinary commands safely collect expired, stopped resources. There is no public cleanup command.
Exit: 0 command completed (including wait timeout and reading a failed task), 1 operation failed,
2 invalid input. Legacy run, poll, preview, --output-file, and Adapter v4 are unsupported.
`;

const options = {
  profile: { type: 'string' }, prompt: { type: 'string' }, name: { type: 'string' },
  workspace: { type: 'string' }, 'instructions-file': { type: 'string' }, file: { type: 'string', multiple: true },
  model: { type: 'string' }, 'reasoning-effort': { type: 'string' }, 'deadline-ms': { type: 'string' },
  run: { type: 'string', multiple: true }, text: { type: 'string' }, 'timeout-ms': { type: 'string' }, export: { type: 'boolean' },
};
const allowed = {
  start: ['profile', 'prompt', 'name', 'workspace', 'instructions-file', 'file', 'model', 'reasoning-effort', 'deadline-ms'],
  send: ['run', 'text'], wait: ['run', 'timeout-ms'], result: ['run', 'export'], stop: ['run'],
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
    if (!value.profile || !Object.hasOwn(value, 'prompt')) fail('argumentsRequired', 'Supply --profile and --prompt TEXT or --prompt -.');
    if (value.name !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value.name)) fail('nameInvalid', 'Use 1-64 ASCII letters, digits, dot, underscore, or hyphen; start with a letter or digit.');
    return { operation, profile: value.profile, prompt: value.prompt, name: value.name, workspace: value.workspace,
      instructionsFile: value['instructions-file'], files: value.file ?? [], model: value.model, reasoningEffort: value['reasoning-effort'],
      ...(value['deadline-ms'] === undefined ? {} : { deadlineMs: integer(value['deadline-ms'], '--deadline-ms', 1, Number.MAX_SAFE_INTEGER - Date.now()) }) };
  }
  const runs = value.run ?? [];
  if (!runs.length || runs.some((handle) => !/^[\x21-\x7e]{1,256}$/.test(handle))) fail('argumentsInvalid', 'Supply a nonempty ASCII run handle of at most 256 bytes.');
  if (operation !== 'wait' && runs.length !== 1) fail('argumentsInvalid', 'This command requires exactly one --run.');
  if (new Set(runs).size > 16) fail('argumentsInvalid', 'wait accepts at most 16 distinct runs.');
  if (operation === 'send' && !Object.hasOwn(value, 'text')) fail('argumentsRequired', 'Supply --text TEXT or --text -.');
  return { operation, runs: [...new Set(runs)], text: value.text, export: value.export ?? false,
    ...(operation === 'wait' ? { timeoutMs: value['timeout-ms'] === undefined ? 600000 : integer(value['timeout-ms'], '--timeout-ms', 0, 1800000) } : {}) };
}

async function installedReader() {
  try { return (await import('./aw-runtime-config.mjs')).readRuntimeConfig; }
  catch { fail('installedRuntimeMissing', 'The AW runtime helper is missing. Sync or reinstall and run from the installed Guide.', ['sync', 'reinstall']); }
}
export async function executeCommand(request, dependencies = {}) {
  if (request.operation === 'help') return { text: HELP, exitCode: 0 };
  let prepared;
  if (request.operation === 'start') {
    const reader = dependencies.readRuntimeConfig ?? await installedReader();
    const snapshot = await reader({ from: import.meta.url, keys: RUNTIME_KEYS });
    prepared = await prepareRun(selectExecution(snapshot, request), request, dependencies);
  }
  if (request.operation === 'send') {
    const text = request.text === '-' ? await readStdin(dependencies.stdin ?? process.stdin, 4096, 'messageTooLarge') : request.text;
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
    if (response.report) for await (const chunk of response.report(response.token)) await writeChunk(process.stdout, chunk);
    else await writeChunk(process.stdout, response.text);
    await new Promise((resolve) => setImmediate(resolve));
    if (outputError) throw outputError;
  } catch {
    await writeChunk(process.stderr, diagnostic('resultOutputFailed', response.compactDiagnostics ? undefined : 'The complete output could not be written. Unread result messages were not consumed.')).catch(() => {});
    process.exitCode = 1; return;
  }
  try { await response.afterOutput?.(); }
  catch (error) {
    const safe = safeError(error);
    await writeChunk(process.stderr, diagnostic(safe.code, response.compactDiagnostics ? undefined : safe.message)).catch(() => {});
    process.exitCode = 1; return;
  }
  if (response.diagnostic) await writeChunk(process.stderr, response.diagnostic);
  process.exitCode = response.exitCode;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch(async (error) => {
  const safe = safeError(error);
  await writeChunk(process.stderr, diagnostic(safe.code, safe.message)).catch(() => {});
  process.exitCode = 2;
});
