import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { atomicJson, atomicJsonFiles, readJson, safePath } from './files.mjs';
import { fail, STATES, runId, validateResult, validateInitialization, validateDiagnostics } from './contracts.mjs';
import { currentUserIdentity, protectPrivatePath, protectPrivatePaths, verifyPrivatePath, verifyPrivatePaths, assertNoReparseTree, windowsOperation } from './platform.mjs';
import { processTable } from './processes.mjs';

export const CACHE_MS = 86400000;
export const terminal = (state) => STATES.includes(state);
export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const handlePattern = /^aw5-([A-Za-z0-9_-]{11})-([A-Za-z0-9_-]{22})$/;
const runKeyPattern = /^[A-Za-z0-9_-]{22}$/;
const recordName = /^[a-z0-9-]+\.json$/;
const identityKeys = ['sourceId', 'sourceIdentity', 'pluginId', 'pluginName', 'platform', 'scope', 'configScope', 'artifactId', 'skillKey'];

export function sameSourceIdentity(left, right) {
  return identityKeys.every((key) => typeof left?.[key] === 'string' && left[key].length > 0 && left[key] === right?.[key]) &&
    left.logicalIdentity === right.logicalIdentity;
}

function retentionMilliseconds(context, meta) {
  const value = context?.retentionHours;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 ||
    !Number.isSafeInteger(value) || value > Math.floor(Number.MAX_SAFE_INTEGER / 3600000) ||
    !sameSourceIdentity(context?.sourceIdentity, meta === undefined ? context?.sourceIdentity : meta.installedIdentity)) return undefined;
  return value * 3600000;
}

export function parseHandle(handle) {
  const match = typeof handle === 'string' && handle.match(handlePattern);
  if (!match) fail('runUnavailable', 'The run handle is unavailable.');
  return { id: match[1], key: match[2] };
}

export async function storeContext(options = {}) {
  const owner = await currentUserIdentity();
  let root = options.root;
  if (root === undefined) {
    const home = await fs.realpath(options.homeRoot ?? os.homedir());
    await safePath(home, 'directory');
    root = path.join(home, '.aw-subagent');
  } else {
    if (!path.isAbsolute(root) || path.normalize(root) !== root || path.basename(root) !== '.aw-subagent') fail('pathInvalid', 'The runtime root is invalid.');
    await safePath(path.dirname(root), 'directory');
  }
  return { owner, root, retentionHours: options.retentionHours === undefined ? 24 : options.retentionHours,
    sourceIdentity: options.sourceIdentity, table: undefined };
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
          await windowsOperation('[IO.Directory]::Move($data.source, $data.destination); $true | ConvertTo-Json -Compress', { source: staging, destination: context.root }, 'rootPublish');
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

export async function createRun(context, name, workspace, installedIdentity = context.sourceIdentity) {
  await prepareRoot(context);
  const id = randomBytes(8).toString('base64url');
  const key = randomBytes(16).toString('base64url');
  const handle = `aw5-${id}-${key}`;
  const entryDirectory = path.join(context.root, id);
  const containerDirectory = path.join(entryDirectory, 'executions');
  await privateDirectory(entryDirectory);
  await privateDirectory(containerDirectory);
  return prepareExecution(context, { id, key, owner: context.owner, name: name ?? `agent-${id.slice(-8)}`, workspace, installedIdentity }, { entryDirectory, containerDirectory, handle });
}

async function prepareExecution(context, stable, paths) {
  const executionId = randomBytes(16).toString('base64url');
  const directory = path.join(paths.containerDirectory, executionId);
  await privateDirectory(directory);
  const children = ['events', 'outbox', 'gaps', 'adapter'].map((part) => path.join(directory, part));
  for (const target of children) await fs.mkdir(target, { mode: 0o700 });
  await protectPrivatePaths(children.map((target) => ({ target, kind: 'directory' })));
  const meta = { schema: 5, ...stable, executionId,
    token: randomBytes(24).toString('hex'), worker: null, processes: [],
    createdAt: Date.now(), terminalAt: null, localTreeStopped: false };
  const snapshot = { state: 'starting', sequence: 1, ready: false, initialization: null, initializationSequence: 0 };
  await atomicJsonFiles([
    { target: path.join(directory, 'owner.json'), value: meta },
    { target: path.join(directory, 'snapshot.json'), value: snapshot },
    { target: path.join(directory, 'observed.json'), value: { sequence: 0, initializationSequence: 0, terminalConsumed: false } },
  ]);
  return { ...paths, directory, meta, snapshot };
}

export async function createExecution(context, previous) {
  const entry = await readEntry(context, previous.meta.id);
  if (entry.key !== previous.meta.key) fail('runUnavailable', 'The run ownership changed.');
  const paths = executionPaths(context, previous.directory);
  await verifyPrivatePath(paths.containerDirectory, 'directory', context.owner);
  // Never recreate the container: a successful empty-container cleanup wins.
  const { id, key, owner, name, workspace, installedIdentity } = previous.meta;
  return prepareExecution(context, { id, key, owner, name, workspace, installedIdentity }, {
    entryDirectory: paths.entryDirectory, containerDirectory: paths.containerDirectory, handle: previous.handle,
  });
}

export async function publishRun(context, run) {
  const verified = await readExecution(context, run.directory, { entry: false });
  if (verified.meta.token !== run.meta.token) fail('runUnavailable', 'The run ownership changed.');
  const { id, key, owner, name, installedIdentity, executionId } = run.meta;
  await atomicJson(path.join(run.entryDirectory, 'current.json'), { schema: 5, id, key, owner, name, installedIdentity, executionId });
}

export async function touchEntry(context, run) {
  try {
    const entry = await readEntry(context, run.meta.id);
    if (entry.key !== run.meta.key) return;
    const now = new Date();
    await fs.utimes(path.join(run.entryDirectory, 'current.json'), now, now);
  } catch { /* Entry freshness is only a best-effort cleanup hint. */ }
}

async function readEntry(context, id) {
  if (!runId(id)) fail('runUnavailable', 'The run is unavailable.');
  const entryDirectory = path.join(context.root, id);
  try {
    await verifyPrivatePaths([
      { target: context.root, kind: 'directory' },
      { target: entryDirectory, kind: 'directory' },
      { target: path.join(entryDirectory, 'current.json'), kind: 'file' },
    ], context.owner);
    return await readVerifiedEntry(context, id);
  } catch { fail('runUnavailable', 'The run ownership cannot be verified.'); }
}

async function readVerifiedEntry(context, id) {
  const entry = await readJson(path.join(context.root, id, 'current.json'), 16384);
  if (entry.schema !== 5 || entry.id !== id || !runKeyPattern.test(entry.key ?? '') ||
    !runKeyPattern.test(entry.executionId ?? '') || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(entry.name ?? '') ||
    JSON.stringify(entry.owner) !== JSON.stringify(context.owner)) fail('runUnavailable', 'The run entry is invalid.');
  return entry;
}

function executionPaths(context, directory) {
  const containerDirectory = path.dirname(directory);
  const entryDirectory = path.dirname(containerDirectory);
  const id = path.basename(entryDirectory);
  if (!path.isAbsolute(directory) || path.normalize(directory) !== directory || !runKeyPattern.test(path.basename(directory)) ||
    path.basename(containerDirectory) !== 'executions' || !runId(id) || path.dirname(entryDirectory) !== context.root) fail('runUnavailable', 'The execution path is invalid.');
  return { id, directory, entryDirectory, containerDirectory };
}

function executionResources(context, paths) {
  return [{ target: context.root, kind: 'directory' }, { target: paths.entryDirectory, kind: 'directory' },
    { target: paths.containerDirectory, kind: 'directory' }, { target: paths.directory, kind: 'directory' },
    { target: path.join(paths.directory, 'owner.json'), kind: 'file' }];
}

async function readVerifiedExecution(context, paths, entry) {
  const { directory, id } = paths;
  try {
    const meta = await readJson(path.join(directory, 'owner.json'), 1024 * 1024);
    if (meta.schema !== 5 || meta.id !== id || meta.executionId !== path.basename(directory) || !runKeyPattern.test(meta.key ?? '') ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(meta.name ?? '') ||
      !/^[a-f0-9]{48}$/.test(meta.token ?? '') || JSON.stringify(meta.owner) !== JSON.stringify(context.owner) ||
      !Array.isArray(meta.processes) || !(meta.terminalAt === null || Number.isSafeInteger(meta.terminalAt) && meta.terminalAt >= 0)) {
      fail('runUnavailable', 'The run ownership information is invalid.');
    }
    if (entry && (entry.key !== meta.key || entry.name !== meta.name || JSON.stringify(entry.installedIdentity) !== JSON.stringify(meta.installedIdentity))) fail('runUnavailable', 'The run ownership changed.');
    return { ...paths, meta, ...(entry ? { entry } : {}), handle: `aw5-${id}-${meta.key}` };
  } catch { fail('runUnavailable', 'The run ownership cannot be verified.'); }
}

export async function readExecution(context, directory, { entry = true } = {}) {
  try {
    const paths = executionPaths(context, directory);
    const current = entry ? await readEntry(context, paths.id) : undefined;
    await verifyPrivatePaths(executionResources(context, paths), context.owner);
    return await readVerifiedExecution(context, paths, current);
  } catch { fail('runUnavailable', 'The execution ownership cannot be verified.'); }
}

export async function readOwner(context, id) {
  try {
    const entry = await readEntry(context, id);
    const directory = path.join(context.root, id, 'executions', entry.executionId);
    const paths = executionPaths(context, directory);
    await verifyPrivatePaths(executionResources(context, paths), context.owner);
    return await readVerifiedExecution(context, paths, entry);
  } catch { fail('runUnavailable', 'The run ownership cannot be verified.'); }
}

async function readOwners(context, ids) {
  const unique = [...new Set(ids)];
  let verified;
  if (unique.length > 1) {
    try {
      await verifyPrivatePaths([
        { target: context.root, kind: 'directory' },
        ...unique.flatMap((id) => [
          { target: path.join(context.root, id), kind: 'directory' },
          { target: path.join(context.root, id, 'current.json'), kind: 'file' },
        ]),
      ], context.owner);
      verified = new Map();
      for (const id of unique) {
        const entry = await readVerifiedEntry(context, id);
        verified.set(id, { entry, paths: executionPaths(context, path.join(context.root, id, 'executions', entry.executionId)) });
      }
      await verifyPrivatePaths([...verified.values()].flatMap(({ paths }) => executionResources(context, paths)), context.owner);
    } catch { verified = undefined; /* Isolate unsafe or missing runs with fresh individual checks. */ }
  }
  const results = new Map();
  for (const id of unique) {
    try { const item = verified?.get(id); results.set(id, { run: await (item ? readVerifiedExecution(context, item.paths, item.entry) : readOwner(context, id)) }); }
    catch (error) { results.set(id, { error }); }
  }
  return results;
}

// Evidence belongs only to this read batch. A later poll calls this again;
// scans never pass their evidence into a command or a destructive operation.
export async function openRuns(context, handles) {
  const parsed = new Map();
  const results = new Map();
  for (const handle of handles) {
    try { parsed.set(handle, parseHandle(handle)); }
    catch (error) { results.set(handle, { error }); }
  }
  const owners = await readOwners(context, [...parsed.values()].map(({ id }) => id));
  for (const [handle, { id, key }] of parsed) {
    try {
      const { run, error } = owners.get(id);
      if (error) throw error;
      if (run.meta.key !== key) fail('runUnavailable', 'The run handle is unavailable.');
      results.set(handle, { run });
    } catch (error) { results.set(handle, { error }); }
  }
  return results;
}

export async function openRun(context, handle) {
  const parsed = parseHandle(handle);
  const run = await readOwner(context, parsed.id);
  if (run.meta.key !== parsed.key) fail('runUnavailable', 'The run handle is unavailable.');
  return run;
}

export const expired = (meta, now = Date.now(), context) => {
  const ttl = retentionMilliseconds(context, meta);
  return ttl !== undefined && Number.isSafeInteger(meta.terminalAt) && meta.terminalAt >= 0 && now - meta.terminalAt >= ttl;
};
export function checkExpiry(meta, context) {
  if (expired(meta, Date.now(), context)) fail('runExpired', 'The run result has expired.');
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
  const latest = await readExecution(context, run.directory);
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
  return readJson(path.join(run.directory, part, name), 262144);
}

export async function saveGap(run, name, input, status, code, message) {
  const gap = { id: input.id, text: input.text, status, code, ...(message ? { message } : {}) };
  await atomicJson(path.join(run.directory, 'gaps', name), gap);
  await fs.unlink(path.join(run.directory, 'outbox', name));
  return gap;
}

export async function observeRun(context, run, { allowExpired = false } = {}) {
  if (!allowExpired) checkExpiry(run.meta, context);
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
  if (!result && !expired(run.meta, Date.now(), context) && !await workerAlive(context, run.meta)) {
    await fixLostTime(context, run);
    if (!allowExpired) checkExpiry(run.meta, context);
    if (!expired(run.meta, Date.now(), context)) {
      // A missing first read is not proof that the worker failed to commit.
      // Re-read after observing its exit; no worker writer remains at this point.
      try { result = validateResult(await readJson(path.join(run.directory, 'final.json'))); }
      catch { /* Only a still-missing or damaged result needs lost-worker recovery. */ }
    }
    if (!expired(run.meta, Date.now(), context) && !result) {
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
    if (!['starting', 'running', 'closing', ...STATES].includes(snapshot.state) || !Number.isSafeInteger(snapshot.sequence) || typeof snapshot.ready !== 'boolean' ||
      !(snapshot.initialization === null || validateInitialization(snapshot.initialization)) || !Number.isSafeInteger(snapshot.initializationSequence) ||
      !Number.isSafeInteger(observed.sequence) || !Number.isSafeInteger(observed.initializationSequence) || typeof observed.terminalConsumed !== 'boolean') throw new Error();
    if (snapshot.diagnostics !== undefined) validateDiagnostics(snapshot.diagnostics);
  } catch { fail('runStateUnavailable', 'The run observation state is unreadable.'); }
  // A worker can publish final.json between the first read and this snapshot.
  // It always publishes the final before a terminal snapshot. Re-read that
  // committed result so the terminal state cannot escape as an empty event.
  if (!result && terminal(snapshot.state)) {
    try { result = validateResult(await readJson(path.join(run.directory, 'final.json'))); }
    catch { fail('runStateUnavailable', 'The terminal result is unreadable.'); }
  }
  if (result) snapshot = { ...snapshot, state: result.state,
    ...(result.initialization ? { initialization: result.initialization,
      initializationSequence: snapshot.initialization === null ? snapshot.sequence + 1 : snapshot.initializationSequence } : {}) };
  return { ...run, snapshot, observed, result };
}

export async function saveObservation(run, { terminalConsumed = run.observed.terminalConsumed, initializationSequence = run.snapshot.initializationSequence } = {}) {
  const observed = { sequence: run.snapshot.sequence, initializationSequence, terminalConsumed };
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

export async function removeExecution(context, run) {
  const latest = await readExecution(context, run.directory, { entry: false });
  if (latest.meta.key !== run.meta.key || latest.meta.token !== run.meta.token) fail('runUnavailable', 'The execution ownership changed.');
  await assertNoReparseTree(run.directory);
  await fs.rm(run.directory, { recursive: true });
}

export async function removeExpired(context, run) {
  if (!expired(run.meta, Date.now(), context)) return false;
  const latest = await readExecution(context, run.directory);
  if (latest.meta.key !== run.meta.key || latest.meta.token !== run.meta.token ||
    latest.meta.terminalAt !== run.meta.terminalAt || latest.meta.localTreeStopped !== run.meta.localTreeStopped ||
    JSON.stringify(latest.meta.worker) !== JSON.stringify(run.meta.worker) ||
    JSON.stringify(latest.meta.processes) !== JSON.stringify(run.meta.processes) || !expired(latest.meta, Date.now(), context)) return false;
  const table = await getTable(context);
  const identities = [latest.meta.worker, ...latest.meta.processes];
  if (identities.some((identity) => !Number.isSafeInteger(identity?.pid) || identity.pid <= 0 || typeof identity.started !== 'string' || !identity.started ||
    table.some((row) => row.pid === identity.pid && row.started === identity.started))) return false;
  // A recorded stopped tree is required: a missing root alone does not prove its descendants stopped.
  if (!latest.meta.localTreeStopped) return false;
  await removeExecution(context, latest);
  return true;
}

function metadataExpired(stat, context, now = Date.now()) {
  const ttl = retentionMilliseconds(context);
  const age = now - stat.mtimeMs;
  return ttl !== undefined && Number.isFinite(stat.mtimeMs) && age > CACHE_MS && age / 2 > ttl;
}

async function removeEntry(context, id, entry, initialStat) {
  const entryDirectory = path.join(context.root, id);
  const current = path.join(entryDirectory, 'current.json');
  const latest = await readEntry(context, id);
  const stat = await fs.lstat(current);
  if (JSON.stringify(latest) !== JSON.stringify(entry) || stat.mtimeMs !== initialStat.mtimeMs || !metadataExpired(stat, context)) return;
  const container = path.join(entryDirectory, 'executions');
  try {
    await verifyPrivatePath(container, 'directory', context.owner);
    // This non-recursive removal arbitrates with creation of the next execution.
    await fs.rmdir(container);
  } catch (error) {
    if (await fs.lstat(container).then(() => true, (probe) => probe.code !== 'ENOENT')) return;
  }
  await fs.unlink(current);
  await fs.rmdir(entryDirectory);
}

async function scanRun(context, id, prepared) {
  const entry = prepared?.entry ?? await readEntry(context, id);
  if (!sameSourceIdentity(entry.installedIdentity, context.sourceIdentity)) return;
  const entryDirectory = path.join(context.root, id);
  const initialStat = await fs.lstat(path.join(entryDirectory, 'current.json'));
  const container = path.join(entryDirectory, 'executions');
  let executions;
  try {
    if (!prepared) await verifyPrivatePath(container, 'directory', context.owner);
    executions = await fs.readdir(container, { withFileTypes: true });
  } catch (error) {
    if (await fs.lstat(container).then(() => true, (probe) => probe.code !== 'ENOENT')) return;
    executions = [];
  }
  if (executions.length) {
    // A run with any initial content stays in the execution branch this round.
    for (const item of executions.slice(0, 128)) {
      if (!item.isDirectory() || !runKeyPattern.test(item.name)) continue;
      try {
        const directory = path.join(container, item.name);
        await removeExpired(context, prepared?.directory === directory ? prepared : await readExecution(context, directory));
      }
      catch { /* Incomplete, changed, unsafe or active executions are retained. */ }
    }
    return;
  }
  if (metadataExpired(initialStat, context)) await removeEntry(context, id, entry, initialStat);
}

export async function scanExpired(context) {
  if (retentionMilliseconds(context) === undefined) return;
  const lock = path.join(context.root, '.scan-lock');
  let acquired = false;
  try {
    await verifyPrivatePath(context.root, 'directory', context.owner);
    await fs.mkdir(lock, { mode: 0o700 });
    acquired = true;
    await protectPrivatePath(lock, 'directory');
    const entries = await fs.readdir(context.root, { withFileTypes: true });
    const ids = entries.filter((item) => item.isDirectory() && runId(item.name)).slice(0, 128).map((item) => item.name);
    const owners = await readOwners(context, ids);
    for (const id of ids) {
      try { await scanRun(context, id, owners.get(id)?.run); } catch { /* Cleanup cannot affect scheduling. */ }
    }
  } catch { /* An existing scanner, unsafe root or any failure is silent. */ }
  finally { if (acquired) await fs.rmdir(lock).catch(() => {}); }
}

export function launchExpiryScan(context) {
  if (retentionMilliseconds(context) === undefined) return;
  try {
    const entrypoint = fileURLToPath(new URL('../scan-expired.mjs', import.meta.url));
    const snapshot = JSON.stringify({ root: context.root, retentionHours: context.retentionHours, sourceIdentity: context.sourceIdentity });
    const env = { ...process.env };
    delete env.AW_SUBAGENT_PROCESS_TOKEN;
    const child = spawn(process.execPath, [entrypoint, snapshot], { detached: true, stdio: 'ignore', shell: false, windowsHide: true, env });
    child.once('error', () => {});
    child.unref();
  } catch { /* The foreground does not wait for or diagnose cleanup. */ }
}
