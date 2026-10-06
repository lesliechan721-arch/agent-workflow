import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { LIMITS, digest, fail } from './contracts.mjs';
import { safePath, readLimited, textFromBytes, inspectMaterials, loadInstructions, executableIdentity, atomicJson, readJson } from './files.mjs';
import { processTable, ownsProcess, stopOwnedTree } from './processes.mjs';

export const ENVIRONMENT_ALLOWLIST = Object.freeze([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR',
  'CODEX_HOME', 'OPENAI_API_KEY', 'AW_SUBAGENT_CODEX_BINARY',
  'AW_AGENT_SKILL_EVAL_PROCESS_MARKER', 'GIT_CONFIG_NOSYSTEM', 'GIT_TERMINAL_PROMPT', 'GIT_OPTIONAL_LOCKS',
]);

export function adapterEnvironment(source = process.env) {
  return Object.fromEntries(ENVIRONMENT_ALLOWLIST.filter((key) => typeof source[key] === 'string').map((key) => [key, source[key]]));
}

export async function prepareRun(plan, request) {
  if (plan.mode === 'native') fail('nativeHostVerificationRequired', 'Use the real host delegation tool after verifying that the current session loaded this exact role revision. The runner cannot create or verify a native handle.');
  if (request.allowMaterialTransfer !== true) fail('materialTransferNotAuthorized', 'This external run needs existing authorization to send the task and selected materials to its service.');
  if (request.allowModelCost !== true) fail('modelCostNotAuthorized', 'This external run needs existing authorization for the model call.');
  if (!request.workspace || !path.isAbsolute(request.workspace)) fail('workspaceRequired', 'External runs need an absolute workspace scope.');
  await safePath(request.workspace, 'directory');
  const taskBytes = await readLimited(path.resolve(request.promptFile ?? ''), LIMITS.taskBytes, 'taskTooLarge');
  const task = textFromBytes(taskBytes);
  if (!task.trim()) fail('taskEmpty', 'The task file is empty.');
  const instructions = await loadInstructions(plan);
  const selected = await inspectMaterials(request.workspace, request.files ?? []);
  const executable = await executableIdentity(plan.executor.command, plan.executor.entrypoint);
  return { plan, workspace: request.workspace, task, instructions, executable, ...selected };
}

export function previewResult(prepared) {
  return {
    ok: true,
    preview: true,
    plan: prepared.plan,
    workspace: prepared.workspace,
    taskBytes: Buffer.byteLength(prepared.task),
    materialBytes: prepared.totalBytes,
    materials: prepared.materials.map(({ bytes, originalPath, ...item }) => item),
    executable: prepared.executable,
    limits: LIMITS,
    generationStarted: false,
  };
}

export function defaultRunsDirectory() {
  return path.join(os.homedir(), '.cache', 'aw-subagent-runs');
}

async function treeBytes(root) {
  let total = 0;
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) fail('runDirectoryUnsafe', 'The run store contains an unsafe node. Select a private clean run directory.');
    total += entry.isDirectory() ? await treeBytes(target) : (await fs.stat(target)).size;
  }
  return total;
}

export async function startRun(prepared, { runsDirectory = defaultRunsDirectory(), environment = process.env } = {}) {
  await processTable();
  await fs.mkdir(runsDirectory, { recursive: true, mode: 0o700 });
  await safePath(runsDirectory, 'directory');
  const rootStat = await fs.stat(runsDirectory);
  if ((rootStat.mode & 0o077) !== 0) fail('runDirectoryNotPrivate', 'The run directory must have mode 0700.');
  if (await treeBytes(runsDirectory) + prepared.totalBytes + LIMITS.outputBytes + LIMITS.logBytes > LIMITS.capacityBytes) fail('runCapacityExceeded', 'The private run store exceeds its capacity. Keep active, unknown, and uncollected runs; remove only completed evidence you no longer need.');
  const id = randomUUID();
  const runDirectory = path.join(runsDirectory, id);
  await fs.mkdir(runDirectory, { mode: 0o700 });
  const materialDirectory = path.join(runDirectory, 'materials');
  await fs.mkdir(materialDirectory, { mode: 0o700 });
  const materials = [];
  for (const item of prepared.materials) {
    const target = path.join(materialDirectory, ...item.source.split('/'));
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fs.writeFile(target, item.bytes, { mode: 0o600, flag: 'wx' });
    const { bytes, originalPath, ...locator } = item;
    materials.push({ ...locator, path: target });
  }
  const plan = prepared.plan;
  const envelope = {
    protocolVersion: 2,
    run: {
      id, mode: plan.mode, access: plan.access, configRevision: plan.configRevision,
      workspace: plan.mode === 'bundle' ? materialDirectory : prepared.workspace,
      ...(plan.model === undefined ? {} : { model: plan.model }),
      ...(plan.reasoningEffort === undefined ? {} : { reasoningEffort: plan.reasoningEffort }),
    },
    instructions: { workerKey: plan.workerKey, revision: plan.worker.instructionRevision, text: prepared.instructions },
    task: prepared.task,
    materials,
  };
  await atomicJson(path.join(runDirectory, 'request.json'), envelope);
  const token = randomBytes(24).toString('hex');
  const record = {
    schemaVersion: 1, id, state: 'running', startedAt: new Date().toISOString(),
    plan, executable: prepared.executable, originalWorkspace: prepared.workspace,
    requestDigest: digest(JSON.stringify(envelope)), processToken: token,
    processes: [], generationMayHaveStarted: false, deadlineMs: LIMITS.deadlineMs,
    outputFile: 'output.md', resultFile: 'receipt.json', diagnosticsFile: 'diagnostics.log',
    retention: { daysAfterCollected: LIMITS.retentionDays, automaticDeletion: false },
  };
  const childEnvironment = adapterEnvironment(environment);
  if (childEnvironment.AW_SUBAGENT_CODEX_BINARY) {
    record.backendExecutable = await executableIdentity(childEnvironment.AW_SUBAGENT_CODEX_BINARY);
    childEnvironment.AW_SUBAGENT_CODEX_BINARY = record.backendExecutable.path;
    childEnvironment.AW_SUBAGENT_CODEX_EXPECTED_SHA256 = record.backendExecutable.sha256;
  }
  await atomicJson(path.join(runDirectory, 'record.json'), record);
  const supervisor = spawn(process.execPath, [fileURLToPath(new URL('./supervise.mjs', import.meta.url)), runDirectory], {
    shell: false, detached: !childEnvironment.AW_AGENT_SKILL_EVAL_PROCESS_MARKER, stdio: 'ignore',
    env: { ...childEnvironment, PATH: environment.PATH ?? '/usr/bin:/bin', HOME: environment.HOME ?? os.homedir(), AW_SUBAGENT_PROCESS_TOKEN: token },
  });
  supervisor.unref();
  await new Promise((resolve, reject) => { supervisor.once('spawn', resolve); supervisor.once('error', reject); });
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    const latest = await readJson(path.join(runDirectory, 'record.json'));
    if (latest.supervisor || latest.state !== 'running') return publicRecord(latest, runsDirectory);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return publicRecord(await readJson(path.join(runDirectory, 'record.json')), runsDirectory);
}

function runPath(runsDirectory, id) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id ?? '')) fail('runIdInvalid', 'Supply the exact UUID of an existing run.');
  return path.join(runsDirectory, id);
}

export function publicRecord(record, runsDirectory) {
  return {
    ok: true, id: record.id, state: record.state, runsDirectory,
    profile: record.plan.profile, workerKey: record.plan.workerKey,
    executorKey: record.plan.executorKey, configRevision: record.plan.configRevision,
    instructionRevision: record.plan.worker.instructionRevision,
    startedAt: record.startedAt, ...(record.endedAt ? { endedAt: record.endedAt } : {}),
    ...(record.code ? { code: record.code } : {}),
    ...(record.receipt ? { receipt: record.receipt } : {}),
    ...(record.localTreeStopped === undefined ? {} : { localTreeStopped: record.localTreeStopped }),
    ...(record.collectedAt ? { collectedAt: record.collectedAt } : {}),
    generationMayHaveStarted: record.generationMayHaveStarted,
  };
}

export async function getRecord(id, runsDirectory = defaultRunsDirectory()) {
  const directory = runPath(runsDirectory, id);
  await safePath(directory, 'directory');
  let record = await readJson(path.join(directory, 'record.json'));
  if (record.schemaVersion !== 1 || record.id !== id || !/^[a-f0-9]{48}$/.test(record.processToken ?? '') || !['running', 'completed', 'failed', 'cancelled', 'unknown'].includes(record.state)) fail('runRecordInvalid', 'The original run record is invalid. No new generation was started.');
  if (record.state === 'running') {
    if (!record.supervisor || !await ownsProcess(record.supervisor, record.processToken)) {
      // The supervisor can atomically publish completion while its process is being checked.
      // Re-read that terminal record before classifying a now-absent process as unknown.
      const latest = await readJson(path.join(directory, 'record.json'));
      if (latest.schemaVersion === 1 && latest.id === id && ['completed', 'failed', 'cancelled', 'unknown'].includes(latest.state)) record = latest;
      else { record.state = 'unknown'; record.code = 'supervisorUnconfirmed'; }
      // Status does not rewrite a concurrently active supervisor record.
    }
  }
  return { record, directory };
}

export async function runStatus(id, runsDirectory) {
  const { record } = await getRecord(id, runsDirectory);
  return publicRecord(record, runsDirectory ?? defaultRunsDirectory());
}

export async function collectRun(id, runsDirectory) {
  const { record, directory } = await getRecord(id, runsDirectory);
  if (record.state !== 'completed') fail('runNotCompleted', `The original run is ${record.state}. Query or cancel this run; do not automatically submit it again.`);
  const text = textFromBytes(await readLimited(path.join(directory, 'output.md'), LIMITS.outputBytes, 'outputTooLarge'));
  if (!text.trim()) fail('runOutputMissing', 'The completed run has no final output.');
  // A separate acknowledgement cannot race or overwrite lifecycle state.
  await fs.writeFile(path.join(directory, 'collected.json'), JSON.stringify({ collectedAt: new Date().toISOString() }), { mode: 0o600 });
  return text;
}

export async function cancelRun(id, runsDirectory) {
  const { record, directory } = await getRecord(id, runsDirectory);
  if (['completed', 'failed', 'cancelled'].includes(record.state)) return publicRecord(record, runsDirectory ?? defaultRunsDirectory());
  if (!record.supervisor || !await ownsProcess(record.supervisor, record.processToken)) {
    const known = Array.isArray(record.processes) ? record.processes : [];
    const owned = [];
    for (const identity of known) if (await ownsProcess(identity, record.processToken)) owned.push(identity);
    if (!owned.length) return { ...publicRecord(record, runsDirectory ?? defaultRunsDirectory()), state: 'unknown', code: 'processOwnershipUnconfirmed', localTreeStopped: false };
    const result = await stopOwnedTree(owned[0].pid, owned, record.processToken);
    record.state = 'unknown';
    record.code = 'remoteStopUnconfirmed';
    record.localTreeStopped = result.stopped;
    record.processes = result.tracked;
    record.endedAt = new Date().toISOString();
    await atomicJson(path.join(directory, 'record.json'), record);
    return publicRecord(record, runsDirectory ?? defaultRunsDirectory());
  }
  await fs.writeFile(path.join(directory, 'cancel.request'), 'cancel\n', { mode: 0o600 });
  process.kill(record.supervisor.pid, 'SIGTERM');
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    const latest = await readJson(path.join(directory, 'record.json'));
    if (latest.state !== 'running') return publicRecord(latest, runsDirectory ?? defaultRunsDirectory());
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return { ...publicRecord(record, runsDirectory ?? defaultRunsDirectory()), state: 'unknown', code: 'cancelUnconfirmed' };
}
