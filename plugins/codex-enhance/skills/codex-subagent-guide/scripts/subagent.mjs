#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { RUNTIME_KEYS, fail, safeError } from './runtime/contracts.mjs';
import { selectExecution } from './runtime/plan.mjs';
import { prepareRun, previewResult, runForeground } from './runtime/runner.mjs';

export const HELP = `Guide foreground runtime (adapter protocol v3)
Usage:
  node subagent.mjs run --profile KEY --instructions-file FILE --prompt-file FILE
    [--workspace DIR] [--file RELATIVE]... [--model MODEL] [--reasoning-effort EFFORT]
    [--access read-only|workspace-write] [--preview]

Workspace defaults to the current directory. Access defaults to read-only.
Preview reads and checks inputs without starting an adapter or model; it is optional.
Native profiles use the host tools directly. Old background commands and flags are unsupported.
Run waits in the foreground. Continue waiting on the same host session after a tool yield.
Inputs are read once; later source changes do not replace these copies. Workspace tools read live files.
Adapters receive independent instructions and task/material data. A user prefix is insufficient.
Materials: 128 UTF-8 files; 1 MiB each; 8 MiB total. No traversal, symlinks, credentials, or truncation.
Task/instructions: 256 KiB each; final text: 4 MiB; diagnostics: 8 MiB; deadline: 30 minutes.
Temporary resources are private and removed after confirmed local completion. No run store or recovery.
Only owned processes are stopped. Unknown remote stop remains unknown.
stdout is JSON; safe input errors use stderr JSON. Exit codes: 0 completed/preview/help, 1 other outcomes, 2 invalid input.
`;

export function parseCommand(argv) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) return { operation: 'help' };
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, strict: true, options: {
      profile: { type: 'string' }, 'instructions-file': { type: 'string' }, 'prompt-file': { type: 'string' },
      workspace: { type: 'string' }, file: { type: 'string', multiple: true },
      model: { type: 'string' }, 'reasoning-effort': { type: 'string' }, access: { type: 'string' }, preview: { type: 'boolean' },
    } });
  } catch { fail('argumentsInvalid', 'An argument is invalid or no longer supported. Run subagent.mjs --help for the v3 interface.'); }
  const [operation, ...rest] = parsed.positionals;
  if (operation !== 'run' || rest.length) fail('operationUnsupported', 'Only run is supported. Use native tools directly, or run the foreground adapter.');
  const values = parsed.values;
  if (!values.profile || !values['instructions-file'] || !values['prompt-file']) fail('argumentsRequired', 'Supply --profile, --instructions-file, and --prompt-file.');
  return { operation, profile: values.profile, instructionsFile: values['instructions-file'], promptFile: values['prompt-file'],
    workspace: values.workspace, files: values.file ?? [], model: values.model, reasoningEffort: values['reasoning-effort'], access: values.access, preview: values.preview ?? false };
}
async function installedReader() {
  try { return (await import('./aw-runtime-config.mjs')).readRuntimeConfig; }
  catch { fail('installedRuntimeMissing', 'The AW runtime helper is missing. Sync or reinstall and run from the installed Guide.', ['sync', 'reinstall']); }
}
export async function executeCommand(request, dependencies = {}) {
  if (request.operation === 'help') return { text: HELP };
  const reader = dependencies.readRuntimeConfig ?? await installedReader();
  const snapshot = await reader({ from: import.meta.url, keys: RUNTIME_KEYS });
  const selected = selectExecution(snapshot, request);
  const prepared = await prepareRun(selected, request);
  return { json: request.preview ? previewResult(prepared) : await runForeground(prepared, dependencies) };
}
async function main() {
  process.umask(0o077);
  const result = await executeCommand(parseCommand(process.argv.slice(2)));
  if (result.text !== undefined) process.stdout.write(result.text);
  else { process.stdout.write(`${JSON.stringify(result.json)}\n`); if (!result.json.preview && result.json.state !== 'completed') process.exitCode = 1; }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch((error) => {
  process.stderr.write(`${JSON.stringify(safeError(error))}\n`);
  process.exitCode = 2;
});
