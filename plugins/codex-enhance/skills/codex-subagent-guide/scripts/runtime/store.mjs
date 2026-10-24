import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { atomicJson, atomicJsonFiles, readJson, safePath } from './files.mjs';
import { fail, STATES, validateResult } from './contracts.mjs';
import { currentUserIdentity, protectPrivatePath, protectPrivatePaths, verifyPrivatePath, verifyPrivatePaths, assertNoReparseTree, windowsOperation } from './platform.mjs';
import { processTable } from './processes.mjs';

export const CACHE_MS = 3600000;
export const terminal = (state) => STATES.includes(state);
export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const handlePattern = /^aw5-([a-f0-9]{32})-([a-f0-9]{32})$/;
const recordName = /^[a-z0-9-]+\.json$/;

export function parseHandle(handle) {
  const match = typeof handle === 'string' && handle.match(handlePattern);
  if (!match) fail('runUnavailable', 'The run handle is unavailable.');
  return { id: match[1], key: match[2] };
}

export async function storeContext(options = {}) {
  const owner = await currentUserIdentity();
  const userKey = createHash('sha256').update(JSON.stringify(owner)).digest('hex').slice(0, 16);
  const temporary = await fs.realpath(options.temporaryRoot ?? os.tmpdir());
  await safePath(temporary, 'directory');
  return { owner, root: path.join(temporary, `aw-subagent-v5-${userKey}`), table: undefined };
}

async function privateDirectory(directory) {
  await fs.mkdir(directory, { mode: 0o700 });
  await protectPrivatePath(directory, 'directory');
}

async function prepareRoot(context) {
  if (process.platform === 'win32') {
    const existing = await fs.lstat(context.root).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
    if (!existing) {
      const staging = await fs.mkdtemp(`${context.root}-`);
      try {
        await protectPrivatePath(staging, 'directory');
        // .NET Framework Directory.Move uses MoveFile without replacement.
        // Publish the protected root only if no file or directory occupies it.
        try {
          await windowsOperation('[IO.Directory]::Move($data.source, $data.destination); $true | ConvertTo-Json -Compress', { source: staging, destination: context.root });
        } catch (error) {
          const published = await fs.lstat(context.root).catch((probe) => { if (probe.code === 'ENOENT') return null; throw probe; });
          if (!published) throw error;
        }
      } finally {
        // Only this invocation's empty staging directory may be removed.
        await fs.rmdir(staging).catch((error) => { if (error.code !== 'ENOENT') throw error; });
      }
    }
  } else {
    try { await privateDirectory(context.root); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  await verifyPrivatePath(context.root, 'directory', context.owner);
}

export async function createRun(context, name, workspace) {
  await prepareRoot(context);
  const id = randomBytes(16).toString('hex');
  const key = randomBytes(16).toString('hex');
  const handle = `aw5-${id}-${key}`;
  const directory = path.join(context.root, id);
  await privateDirectory(directory);
  const children = ['events', 'outbox', 'gaps', 'adapter'].map((part) => path.join(directory, part));
  for (const target of children) await fs.mkdir(target, { mode: 0o700 });
  await protectPrivatePaths(children.map((target) => ({ target, kind: 'directory' })));
  const meta = { schema: 5, id, key, owner: context.owner, name: name ?? `agent-${id.slice(-8)}`,
    workspace, token: randomBytes(24).toString('hex'), worker: null, processes: [],
    createdAt: Date.now(), terminalAt: null, localTreeStopped: false };
  const snapshot = { state: 'starting', sequence: 1, communicationSupported: null, communicationSequence: 0 };
  await atomicJsonFiles([
    { target: path.join(directory, 'owner.json'), value: meta },
    { target: path.join(directory, 'snapshot.json'), value: snapshot },
    { target: path.join(directory, 'observed.json'), value: { sequence: 0, communicationSequence: 0, terminalConsumed: false } },
  ]);
  return { directory, handle, meta, snapshot };
}

export async function readOwner(context, id) {
  if (!/^[a-f0-9]{32}$/.test(id)) fail('runUnavailable', 'The run is unavailable.');
  const directory = path.join(context.root, id);
  try {
    await verifyPrivatePaths([
      { target: context.root, kind: 'directory' },
      { target: directory, kind: 'directory' },
      { target: path.join(directory, 'owner.json'), kind: 'file' },
    ], context.owner);
    const meta = await readJson(path.join(directory, 'owner.json'), 1024 * 1024);
    if (meta.schema !== 5 || meta.id !== id || !/^[a-f0-9]{32}$/.test(meta.key ?? '') ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(meta.name ?? '') ||
      !/^[a-f0-9]{48}$/.test(meta.token ?? '') || JSON.stringify(meta.owner) !== JSON.stringify(context.owner) ||
      !Array.isArray(meta.processes) || !(meta.terminalAt === null || Number.isSafeInteger(meta.terminalAt) && meta.terminalAt >= 0)) {
      fail('runUnavailable', 'The run ownership information is invalid.');
    }
    return { directory, meta, handle: `aw5-${id}-${meta.key}` };
  } catch { fail('runUnavailable', 'The run ownership cannot be verified.'); }
}

export async function openRun(context, handle) {
  const parsed = parseHandle(handle);
  const run = await readOwner(context, parsed.id);
  if (run.meta.key !== parsed.key) fail('runUnavailable', 'The run handle is unavailable.');
  return run;
}

export const expired = (meta, now = Date.now()) => meta.terminalAt !== null && now >= meta.terminalAt + CACHE_MS;
export function checkExpiry(meta) {
  if (expired(meta)) fail('runExpired', 'The run result has expired.');
}

async function getTable(context) {
  if (!context.table) {
    try { context.table = await processTable(); }
    catch { fail('runObservationFailed', 'The original worker identity could not be checked.'); }
  }
  return context.table;
}

export async function workerAlive(context, meta) {
  if (!Number.isSafeInteger(meta.worker?.pid) || !meta.worker?.started) fail('runObservationFailed', 'The worker startup identity is unavailable.');
  return (await getTable(context)).some((row) => row.pid === meta.worker.pid && row.started === meta.worker.started);
}

async function fixLostTime(context, run) {
  if (run.meta.terminalAt !== null || await workerAlive(context, run.meta)) return false;
  // The worker can commit its clock while the parent observes its exit. Its
  // last owner record is authoritative once that worker is no longer alive.
  const latest = await readOwner(context, run.meta.id);
  if (latest.meta.key !== run.meta.key || latest.meta.token !== run.meta.token) fail('runUnavailable', 'The run ownership changed.');
  run.meta = latest.meta;
  if (run.meta.terminalAt !== null) return false;
  run.meta.terminalAt = Date.now();
  try { await atomicJson(path.join(run.directory, 'owner.json'), run.meta); }
  catch { fail('runStateUnavailable', 'The fixed terminal time could not be saved.'); }
  return true;
}

export async function recordFiles(run, part) {
  const directory = path.join(run.directory, part);
  await safePath(directory, 'directory');
  const entries = await fs.readdir(directory, { withFileTypes: true });
  if (entries.some((entry) => !entry.isFile() || !recordName.test(entry.name) && !entry.name.endsWith('.tmp'))) {
    fail('runStateUnavailable', 'A run queue contains an invalid resource.');
  }
  return entries.filter((entry) => recordName.test(entry.name)).map((entry) => entry.name).sort();
}

export async function readRecord(run, part, name) {
  if (!recordName.test(name)) fail('runStateUnavailable', 'A run record name is invalid.');
  return readJson(path.join(run.directory, part, name), 65536);
}

export async function saveGap(run, name, input, status, code, message) {
  const gap = { id: input.id, text: input.text, status, code, ...(message ? { message } : {}) };
  await atomicJson(path.join(run.directory, 'gaps', name), gap);
  await fs.unlink(path.join(run.directory, 'outbox', name));
  return gap;
}

export async function observeRun(context, run, { allowExpired = false } = {}) {
  if (!allowExpired) checkExpiry(run.meta);
  let result;
  try { result = validateResult(await readJson(path.join(run.directory, 'final.json'))); }
  catch {
    const exists = await fs.lstat(path.join(run.directory, 'final.json')).catch((e) => { if (e.code === 'ENOENT') return null; throw e; });
    if (exists) {
      // Atomic publication can occur after the first missing-file read. Check
      // the now-visible result before classifying it as damaged.
      try { result = validateResult(await readJson(path.join(run.directory, 'final.json'))); }
      catch { if (await workerAlive(context, run.meta)) fail('runStateUnavailable', 'The final result is unreadable.'); }
    }
  }
  if (!result && !expired(run.meta) && !await workerAlive(context, run.meta)) {
    await fixLostTime(context, run);
    if (!allowExpired) checkExpiry(run.meta);
    if (!expired(run.meta)) {
      // A missing first read is not proof that the worker failed to commit.
      // Re-read after observing its exit; no worker writer remains at this point.
      try { result = validateResult(await readJson(path.join(run.directory, 'final.json'))); }
      catch { /* Only a still-missing or damaged result needs lost-worker recovery. */ }
    }
    if (!expired(run.meta) && !result) {
      try {
        for (const name of await recordFiles(run, 'outbox')) {
          const input = await readRecord(run, 'outbox', name);
          const status = input.phase === 'queued' ? 'notSubmitted' : 'unknown';
          await saveGap(run, name, input, status, status === 'unknown' ? 'inputDeliveryUnknown' : 'workerLost');
        }
        result = { protocolVersion: 5, type: 'result', state: 'unknown', generationStarted: null,
          backendExitCode: null, text: '', code: 'workerLost', message: 'Final text was not saved.' };
        await atomicJson(path.join(run.directory, 'final.json'), result);
      } catch { fail('runStateUnavailable', 'The lost-worker result could not be saved.'); }
    }
  }
  let snapshot, observed;
  try {
    snapshot = await readJson(path.join(run.directory, 'snapshot.json'), 16384);
    observed = await readJson(path.join(run.directory, 'observed.json'), 4096);
    if (!['starting', 'running', 'closing', ...STATES].includes(snapshot.state) || !Number.isSafeInteger(snapshot.sequence) ||
      ![null, true, false].includes(snapshot.communicationSupported) || !Number.isSafeInteger(snapshot.communicationSequence) ||
      !Number.isSafeInteger(observed.sequence) || !Number.isSafeInteger(observed.communicationSequence) || typeof observed.terminalConsumed !== 'boolean') throw new Error();
  } catch { fail('runStateUnavailable', 'The run observation state is unreadable.'); }
  // A worker can publish final.json between the first read and this snapshot.
  // It always publishes the final before a terminal snapshot. Re-read that
  // committed result so the terminal state cannot escape as an empty event.
  if (!result && terminal(snapshot.state)) {
    try { result = validateResult(await readJson(path.join(run.directory, 'final.json'))); }
    catch { fail('runStateUnavailable', 'The terminal result is unreadable.'); }
  }
  if (result) snapshot = { ...snapshot, state: result.state };
  return { ...run, snapshot, observed, result };
}

export async function saveObservation(run, { terminalConsumed = run.observed.terminalConsumed } = {}) {
  const observed = { sequence: run.snapshot.sequence, communicationSequence: run.snapshot.communicationSequence, terminalConsumed };
  await atomicJson(path.join(run.directory, 'observed.json'), observed);
  run.observed = observed;
}

export async function removeScratch(run) {
  if (!run.meta.localTreeStopped) return false;
  const directory = path.join(run.directory, 'adapter');
  const entry = await fs.lstat(directory).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
  if (!entry) return true;
  await verifyPrivatePath(directory, 'directory', run.meta.owner);
  await assertNoReparseTree(directory);
  await fs.rm(directory, { recursive: true });
  return true;
}

export async function removeExpired(context, run) {
  if (!expired(run.meta)) return false;
  const table = await getTable(context);
  const identities = [run.meta.worker, ...run.meta.processes].filter(Boolean);
  if (!run.meta.worker?.started || identities.some((identity) => table.some((row) => row.pid === identity.pid && row.started === identity.started))) return false;
  // A recorded stopped tree is required: a missing root alone does not prove its descendants stopped.
  if (!run.meta.localTreeStopped) return false;
  await assertNoReparseTree(run.directory);
  await fs.rm(run.directory, { recursive: true });
  return true;
}

export async function scanExpired(context) {
  let failures = 0;
  let entries;
  try {
    await verifyPrivatePath(context.root, 'directory', context.owner);
    entries = await fs.readdir(context.root, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT' || !await fs.lstat(context.root).catch(() => null)) return false;
    return true;
  }
  for (const entry of entries.filter((item) => item.isDirectory() && /^[a-f0-9]{32}$/.test(item.name)).slice(0, 128)) {
    try {
      const run = await readOwner(context, entry.name);
      if (run.meta.terminalAt === null && run.meta.worker) await fixLostTime(context, run);
      if (expired(run.meta)) await removeExpired(context, run);
    } catch { failures += 1; }
  }
  return failures > 0;
}
