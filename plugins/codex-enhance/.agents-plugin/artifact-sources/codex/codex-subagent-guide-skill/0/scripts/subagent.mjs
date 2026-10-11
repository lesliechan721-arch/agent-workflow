#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { RUNTIME_KEYS, fail, safeError } from './runtime/contracts.mjs';
import { selectExecution } from './runtime/plan.mjs';
import { prepareRun, previewResult, formatPreview, formatResult, runForeground } from './runtime/runner.mjs';

export const HELP = `Guide foreground runtime (adapter protocol v4)
Usage:
  node scripts/subagent.mjs run --profile KEY --prompt TEXT|-
    [--instructions-file FILE] [--workspace DIR] [--file SELECTOR]...
    [--model MODEL] [--reasoning-effort EFFORT] [--preview]

--prompt - reads noninteractive UTF-8 stdin until EOF. Supply --prompt exactly once.
Instructions are optional; relative instruction paths use the caller's current directory.
Workspace defaults to the current directory. Workspace execution rejects every --file.
Bundle keeps each raw selector; quote globs. Selection follows AW file selection protocol v1.
Preview does not expand selectors, inspect matching files, or start an adapter/helper/backend.
Native profiles use host tools directly. Old access, prompt-file, background flags and v3 are unsupported.
Run waits on one foreground call. After a tool yield, continue waiting on the same host session.
Backend permissions and configuration remain in effect. These modes do not provide OS isolation.
Task/instructions: 256 KiB each; v4 JSON: 8 MiB; final text: 4 MiB; diagnostics: 8 MiB;
result file: 32 MiB; deadline: 30 minutes. No truncation or automatic second submission.
Temporary resources are private and removed after confirmed local completion.
Only owned processes are stopped. Unknown remote stop remains unknown.
stdout is text. Input errors use stderr text. Exit: 0 completed/preview/help, 1 other run outcomes, 2 invalid input.
`;

export function parseCommand(argv) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) return { operation: 'help' };
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, strict: true, tokens: true, options: {
      profile: { type: 'string' }, 'instructions-file': { type: 'string' }, prompt: { type: 'string' },
      workspace: { type: 'string' }, file: { type: 'string', multiple: true },
      model: { type: 'string' }, 'reasoning-effort': { type: 'string' }, preview: { type: 'boolean' },
    } });
  } catch { fail('argumentsInvalid', 'An argument is invalid or unsupported. Run scripts/subagent.mjs --help for v4.'); }
  const [operation, ...rest] = parsed.positionals;
  if (operation !== 'run' || rest.length) fail('operationUnsupported', 'Only run is supported. Use native tools directly, or run a foreground adapter.');
  const values = parsed.values;
  if (!values.profile || !Object.hasOwn(values, 'prompt')) fail('argumentsRequired', 'Supply --profile and --prompt TEXT or --prompt -.');
  if (parsed.tokens.filter((token) => token.kind === 'option' && token.name === 'prompt').length !== 1) fail('promptDuplicate', 'Supply --prompt exactly once.');
  return { operation, profile: values.profile, instructionsFile: values['instructions-file'], prompt: values.prompt,
    workspace: values.workspace, files: values.file ?? [], model: values.model, reasoningEffort: values['reasoning-effort'], preview: values.preview ?? false };
}
async function installedReader() {
  try { return (await import('./aw-runtime-config.mjs')).readRuntimeConfig; }
  catch { fail('installedRuntimeMissing', 'The AW runtime helper is missing. Sync or reinstall and run from the installed Guide.', ['sync', 'reinstall']); }
}
export async function executeCommand(request, dependencies = {}) {
  if (request.operation === 'help') return { text: HELP, exitCode: 0 };
  const reader = dependencies.readRuntimeConfig ?? await installedReader();
  const snapshot = await reader({ from: import.meta.url, keys: RUNTIME_KEYS });
  const selected = selectExecution(snapshot, request);
  const prepared = await prepareRun(selected, request, dependencies);
  if (request.preview) return { text: formatPreview(previewResult(prepared)), exitCode: 0 };
  const result = await runForeground(prepared, dependencies);
  return { text: formatResult(result, prepared.request.execution, prepared.request.mode), exitCode: result.state === 'completed' ? 0 : 1,
    ...(result.state !== 'completed' && result.message ? { diagnostic: result.message.slice(0, 2048) } : {}) };
}
async function main() {
  process.umask(0o077);
  const result = await executeCommand(parseCommand(process.argv.slice(2)));
  process.stdout.write(result.text);
  if (result.diagnostic) process.stderr.write(`${result.diagnostic}\n`);
  process.exitCode = result.exitCode;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch((error) => {
  const safe = safeError(error);
  process.stderr.write(`${safe.code}: ${safe.message}${safe.recoveryActions.length ? ` Recovery: ${safe.recoveryActions.join(', ')}.` : ''}\n`);
  process.exitCode = 2;
});
