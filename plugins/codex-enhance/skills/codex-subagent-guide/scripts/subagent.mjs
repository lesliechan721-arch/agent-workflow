#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { RUNTIME_KEYS, fail, safeError } from './runtime/contracts.mjs';
import { readJson, loadInstructions } from './runtime/files.mjs';
import { resolvePlan } from './runtime/plan.mjs';
import { prepareRun, previewResult, startRun, runStatus, collectRun, cancelRun } from './runtime/runner.mjs';

export const HELP = `Guide subagent runtime (instruction protocol v2)
Usage:
  node subagent.mjs resolve --profile KEY [--worker KEY] [--access read-only|workspace-write] [--expected-revision REV]
    [--model MODEL] [--reasoning-effort EFFORT]
  node subagent.mjs run --profile KEY --workspace ABS --prompt-file FILE [--file RELATIVE]... [--preview]
    [--worker KEY] [--access read-only|workspace-write] [--expected-revision REV]
    [--model MODEL] [--reasoning-effort EFFORT]
    [--require-isolation] [--allow-material-transfer] [--allow-model-cost] [--runs-dir ABS]
  node subagent.mjs status|collect|cancel --run UUID [--runs-dir ABS]

resolve and preview return a JSON plan without launching any adapter or model.
run returns a JSON run ID after launching a managed background runner.
status and cancel return JSON. collect returns the original final Markdown.
Permission flags carry existing task authorization. They do not grant new permission.
Model and effort independently use explicit request, then profile preference, then an omitted backend default.
Explicit values are hard requirements. No executor switch, model fallback, or new generation is automatic.
Native plans require real host delegation and current loaded-role evidence; native run is unsupported here.
Strong scope isolation and resume are unsupported. Configuration booleans do not establish qualification.
Materials: 128 UTF-8 files; 1 MiB each; 8 MiB total. No symlinks, traversal, default secrets, or truncation.
Task/instructions: 256 KiB each; final output: 4 MiB; diagnostics: 8 MiB; deadline: 30 minutes.
Private run store: 0700 directories / 0600 files; 256 MiB capacity. No automatic deletion.
Keep active, unknown, and uncollected evidence. After collection, keep evidence for at least 7 days as needed.
External managed execution supports macOS/Linux cooperative process trees. Remote stop can remain unknown.
stdout contains one JSON object or collected Markdown; errors use safe JSON on stderr.
Exit codes: 0 success, 1 operation failed/unconfirmed, 2 invalid or unsupported request.
`;

export function parseCommand(argv) {
  if (argv.includes('--help') || argv.includes('-h')) return { operation: 'help' };
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, strict: true, options: {
      profile: { type: 'string' }, worker: { type: 'string' }, access: { type: 'string' },
      model: { type: 'string' }, 'reasoning-effort': { type: 'string' },
      workspace: { type: 'string' }, 'prompt-file': { type: 'string' }, file: { type: 'string', multiple: true },
      'expected-revision': { type: 'string' }, 'require-isolation': { type: 'boolean' },
      'allow-material-transfer': { type: 'boolean' }, 'allow-model-cost': { type: 'boolean' },
      preview: { type: 'boolean' }, run: { type: 'string' }, 'runs-dir': { type: 'string' },
    } });
  } catch { fail('argumentsInvalid', 'Invalid runtime arguments. Run subagent.mjs --help.'); }
  const [operation, ...rest] = parsed.positionals;
  if (rest.length || !['resolve', 'run', 'status', 'collect', 'cancel'].includes(operation)) fail('operationUnsupported', 'Choose resolve, run, status, collect, or cancel. Resume is not supported.');
  const values = parsed.values;
  if (values['runs-dir'] && !path.isAbsolute(values['runs-dir'])) fail('runDirectoryInvalid', 'The run directory must be absolute.');
  const recovering = ['status', 'collect', 'cancel'].includes(operation);
  const allowed = recovering ? new Set(['run', 'runs-dir']) : operation === 'resolve' ? new Set(['profile', 'worker', 'access', 'model', 'reasoning-effort', 'expected-revision', 'require-isolation']) : new Set(Object.keys(values).filter((key) => key !== 'run'));
  if (Object.keys(values).some((key) => !allowed.has(key))) fail('argumentsInvalid', 'An argument does not apply to this operation.');
  if (recovering ? !values.run : !values.profile) fail('argumentsRequired', recovering ? 'Supply an existing run UUID.' : 'Supply a declared profile key.');
  return {
    operation, id: values.run, runsDirectory: values['runs-dir'], preview: values.preview ?? false,
    profile: values.profile, worker: values.worker, access: values.access,
    model: values.model, reasoningEffort: values['reasoning-effort'],
    expectedRevision: values['expected-revision'], requireIsolation: values['require-isolation'] ?? false,
    workspace: values.workspace, promptFile: values['prompt-file'], files: values.file ?? [],
    allowMaterialTransfer: values['allow-material-transfer'] ?? false, allowModelCost: values['allow-model-cost'] ?? false,
  };
}

async function installedReader() {
  try { return (await import('./aw-runtime-config.mjs')).readRuntimeConfig; }
  catch { fail('installedRuntimeMissing', 'The AW installed runtime helper is missing. Run this entry from a complete installed Guide Skill.', ['sync', 'reinstall']); }
}

export async function loadPlan(request, readRuntimeConfig = undefined) {
  const reader = readRuntimeConfig ?? await installedReader();
  const snapshot = await reader({ from: import.meta.url, keys: RUNTIME_KEYS, ...(request.expectedRevision ? { expectedRevision: request.expectedRevision } : {}) });
  const binding = await readJson(path.join(snapshot.resourceRoot, 'runtime', 'worker-bindings.json'));
  const plan = resolvePlan(snapshot, binding, request);
  await loadInstructions(plan);
  return { plan, reader };
}

export async function executeCommand(request, dependencies = {}) {
  if (request.operation === 'help') return { text: HELP };
  if (request.operation === 'status') return { json: await runStatus(request.id, request.runsDirectory) };
  if (request.operation === 'collect') return { text: await collectRun(request.id, request.runsDirectory) };
  if (request.operation === 'cancel') return { json: await cancelRun(request.id, request.runsDirectory) };
  const { plan, reader } = await loadPlan(request, dependencies.readRuntimeConfig);
  if (request.operation === 'resolve') return { json: { ok: true, plan } };
  if (!request.promptFile) fail('taskFileRequired', 'Run and preview require --prompt-file.');
  const prepared = await prepareRun(plan, request);
  if (request.preview) return { json: previewResult(prepared) };
  await reader({ from: import.meta.url, keys: RUNTIME_KEYS, expectedRevision: plan.configRevision });
  return { json: await startRun(prepared, { runsDirectory: request.runsDirectory }) };
}

async function main() {
  const result = await executeCommand(parseCommand(process.argv.slice(2)));
  if (result.text !== undefined) process.stdout.write(result.text);
  else process.stdout.write(`${JSON.stringify(result.json)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch((error) => {
  process.stderr.write(`${JSON.stringify(safeError(error))}\n`);
  process.exitCode = /Invalid|Unsupported|Required|NotAllowed|Unknown|NotAuthorized|Missing|Mismatch|TooLarge|Exceeded|Excluded|Symlink|NotPrivate/.test(error?.code ?? '') ? 2 : 1;
});
