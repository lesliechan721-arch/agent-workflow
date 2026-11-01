import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { store, files, processes, setNativeStorageHost } from './fixtures/storage-runtime.mjs';

const require = createRequire(import.meta.url);
const scanEntrypoint = require.resolve('../skills/codex-subagent-guide/scripts/scan-expired.mjs');
const { atomicJson, readJson } = files;
const hour = 3600000;
const identity = { sourceId: 'fixture', sourceIdentity: 'fixture-source', pluginId: 'fixture/codex-enhance', pluginName: 'codex-enhance',
  pluginVersion: '1.0.0', platform: 'codex', scope: 'user', configScope: 'user', artifactId: 'guide', skillKey: 'codex-subagent-guide' };
const absent = (target) => fs.lstat(target).then(() => false, (error) => { if (error.code === 'ENOENT') return true; throw error; });

async function temporaryHome(t) {
  const homeRoot = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'aw-storage-'));
  t.after(() => fs.rm(homeRoot, { recursive: true, force: true }));
  return homeRoot;
}

async function contextFixture(t, retentionHours, nativeHost = false) {
  setNativeStorageHost(nativeHost);
  t.after(() => setNativeStorageHost(true));
  const homeRoot = await temporaryHome(t);
  const context = await store.storeContext({ homeRoot, retentionHours, sourceIdentity: identity });
  if (!nativeHost) context.table = [];
  return { homeRoot, context };
}

async function fixture(t, retentionHours = 24, nativeHost = false) {
  const { homeRoot, context } = await contextFixture(t, retentionHours, nativeHost);
  const run = await store.createRun(context, 'fixture', homeRoot, identity);
  await store.publishRun(context, run);
  return { homeRoot, context, run };
}

async function emptyEntry(t, retentionHours = 24) {
  const { homeRoot, context } = await contextFixture(t, retentionHours);
  const id = 'a'.repeat(11), key = 'b'.repeat(22), executionId = 'c'.repeat(22);
  const entryDirectory = path.join(context.root, id);
  const containerDirectory = path.join(entryDirectory, 'executions');
  for (const directory of [context.root, entryDirectory, containerDirectory]) await fs.mkdir(directory, { mode: 0o700 });
  await atomicJson(path.join(entryDirectory, 'current.json'), { schema: 5, id, key, name: 'fixture', owner: context.owner, installedIdentity: identity, executionId });
  return { homeRoot, context, run: { entryDirectory, containerDirectory } };
}

async function ended(run, terminalAt, worker = { pid: 2147483647, started: 'stopped-fixture' }) {
  Object.assign(run.meta, { terminalAt, worker, localTreeStopped: true });
  await atomicJson(path.join(run.directory, 'owner.json'), run.meta);
}

async function ageEntry(run, hours) {
  const time = new Date(Date.now() - hours * hour);
  await fs.utimes(path.join(run.entryDirectory, 'current.json'), time, time);
}

// Test Value Gate: a published handle must select only its current independent
// execution; real owner/ACL and process observations must protect deletion, and
// missing current content must not fall back to a prior result.
test('native fixed entry publishes executions and protects owned active processes', async (t) => {
  const f = await fixture(t, 1, true);
  assert.equal(f.context.root, path.join(f.homeRoot, '.aw-subagent'));
  const second = await store.createExecution(f.context, f.run);
  assert.notEqual(second.directory, f.run.directory);
  assert.notEqual(second.meta.token, f.run.meta.token);
  assert.equal(second.meta.terminalAt, null);
  assert.equal((await store.openRun(f.context, f.run.handle)).directory, f.run.directory);
  await atomicJson(path.join(second.directory, 'resume.json'), { sessionId: 'preserved' });
  await store.publishRun(f.context, second);
  assert.equal((await store.openRun(f.context, f.run.handle)).directory, second.directory);
  assert.equal((await store.readExecution(f.context, f.run.directory)).directory, f.run.directory);
  const owner = second.meta.owner;
  await atomicJson(path.join(second.directory, 'owner.json'), { ...second.meta, owner: { ...owner, foreign: true } });
  await assert.rejects(store.openRun(f.context, second.handle), { code: 'runUnavailable' });
  await atomicJson(path.join(second.directory, 'owner.json'), second.meta);
  await ended(f.run, Date.now() - 2 * hour, await processes.processIdentity(process.pid));
  assert.equal(await store.removeExpired(f.context, f.run), false, 'A real live process prevents expired execution deletion.');
  await ended(second, Date.now() - 2 * hour);
  assert.equal(await store.removeExpired(f.context, second), true);
  await assert.rejects(store.openRun(f.context, f.run.handle));
  assert.ok(await fs.stat(f.run.directory));
});

// Test Value Gate: current configuration, exact TTL boundaries and disabled or
// invalid settings determine logical expiry without modifying saved state.
test('expiry follows a safe current configuration snapshot and source identity', async (t) => {
  const context = { retentionHours: 24, sourceIdentity: identity };
  const at = Date.now() - 30 * hour;
  const meta = { terminalAt: at, installedIdentity: identity };
  const root = await temporaryHome(t);
  await fs.writeFile(path.join(root, 'saved-state'), JSON.stringify(meta));
  const before = await fs.readFile(path.join(root, 'saved-state'), 'utf8');
  assert.equal(store.expired(meta, at + 24 * hour - 1, context), false);
  assert.equal(store.expired(meta, at + 24 * hour, context), true);
  assert.equal(store.expired(meta, at + 30 * hour, { ...context, retentionHours: 48 }), false);
  for (const value of [0, -1, NaN, Infinity, '24', null, 0.5, Number.MAX_SAFE_INTEGER]) {
    assert.equal(store.expired(meta, Date.now(), { ...context, retentionHours: value }), false, String(value));
    await store.scanExpired({ ...context, root, retentionHours: value });
    assert.deepEqual(await fs.readdir(root), ['saved-state']);
  }
  assert.equal(store.expired(meta, Date.now(), { ...context, sourceIdentity: undefined }), false);
  assert.equal(store.expired(meta, Date.now(), { ...context, sourceIdentity: { ...identity, sourceIdentity: 'foreign' } }), false);
  assert.equal(store.expired(meta, Date.now(), { ...context, sourceIdentity: { ...identity, pluginVersion: '2.0.0' } }), true);
  assert.equal(await fs.readFile(path.join(root, 'saved-state'), 'utf8'), before);
});

// Test Value Gate: clearing expired execution data and clearing entry metadata
// in separate rounds protects recovery preparation and preserves unknown nodes.
test('scans separate execution deletion from strictly older empty metadata', async (t) => {
  const f = await fixture(t, 1);
  await ended(f.run, Date.now() - 2 * hour);
  await store.scanExpired({ ...f.context, sourceIdentity: { ...identity, sourceIdentity: 'foreign' } });
  assert.ok(await fs.stat(f.run.directory), 'A different source cannot delete expired content.');
  const changed = { ...f.run.meta, token: 'a'.repeat(48) };
  await atomicJson(path.join(f.run.directory, 'owner.json'), changed);
  assert.equal(await store.removeExpired(f.context, f.run), false);
  assert.ok(await fs.stat(f.run.directory), 'Changed execution evidence is retained.');
  await atomicJson(path.join(f.run.directory, 'owner.json'), f.run.meta);
  await ageEntry(f.run, 49);
  await store.scanExpired(f.context);
  assert.equal(await absent(f.run.directory), true);
  assert.ok(await fs.stat(f.run.containerDirectory));
  assert.ok(await fs.stat(path.join(f.run.entryDirectory, 'current.json')));
  await store.scanExpired(f.context);
  assert.equal(await absent(f.run.entryDirectory), true);

  for (const [ttl, interval] of [[1, 24], [12, 24], [24, 48], [48, 96]]) {
    const g = await emptyEntry(t, ttl);
    const current = path.join(g.run.entryDirectory, 'current.json');
    await fs.utimes(current, new Date(1000), new Date(1000));
    const boundary = (await fs.stat(current)).mtimeMs + interval * hour;
    const now = t.mock.method(Date, 'now', () => boundary);
    await store.scanExpired(g.context);
    assert.ok(await fs.stat(g.run.entryDirectory), `TTL ${ttl}: exact metadata boundary is retained.`);
    now.mock.restore();
    const after = t.mock.method(Date, 'now', () => boundary + 1);
    await store.scanExpired(g.context);
    assert.equal(await absent(g.run.entryDirectory), true, `TTL ${ttl}: one millisecond beyond is eligible.`);
    after.mock.restore();
  }
  const maximum = await emptyEntry(t, Math.floor(Number.MAX_SAFE_INTEGER / hour));
  await fs.utimes(path.join(maximum.run.entryDirectory, 'current.json'), new Date(0), new Date(0));
  const largestClock = t.mock.method(Date, 'now', () => Number.MAX_SAFE_INTEGER);
  await store.scanExpired(maximum.context);
  assert.ok(await fs.stat(maximum.run.entryDirectory), 'The maximum legal TTL does not overflow its doubled metadata interval.');
  largestClock.mock.restore();
  const g = await emptyEntry(t);
  await ageEntry(g.run, 49);
  await fs.writeFile(path.join(g.run.containerDirectory, 'unknown'), 'preserve');
  await store.scanExpired(g.context);
  assert.equal(await fs.readFile(path.join(g.run.containerDirectory, 'unknown'), 'utf8'), 'preserve');
});

// Test Value Gate: cleanup must not repair lost workers, delete live process
// evidence, or allow an old scanner to remove the newly published execution.
test('scans retain incomplete and active executions and bind deletion to the old directory', async (t) => {
  const f = await fixture(t, 1);
  await store.scanExpired(f.context);
  assert.equal((await readJson(path.join(f.run.directory, 'owner.json'))).terminalAt, null);
  const worker = { pid: process.pid, started: 'fixture-live-process' };
  f.context.table = [worker];
  await ended(f.run, Date.now() - 2 * hour, worker);
  await store.scanExpired(f.context);
  assert.ok(await fs.stat(f.run.directory));
  await ended(f.run, Date.now() - 2 * hour);
  const second = await store.createExecution(f.context, f.run);
  await store.publishRun(f.context, second);
  await store.scanExpired(f.context);
  assert.equal(await absent(f.run.directory), true);
  assert.equal((await store.openRun(f.context, second.handle)).directory, second.directory);
  assert.equal((await readJson(path.join(second.directory, 'owner.json'))).terminalAt, null);
});

// Test Value Gate: recovery creation and empty-container removal arbitrate
// through the real filesystem; recovery cannot recreate a removed container.
test('entry refresh and non-recursive container removal protect recovery preparation', async (t) => {
  const f = await fixture(t, 1);
  await fs.rm(f.run.directory, { recursive: true });
  await ageEntry(f.run, 49);
  const readdir = fs.readdir;
  const refreshed = t.mock.method(fs, 'readdir', async (target, ...args) => {
    const result = await readdir.call(fs, target, ...args);
    if (target === f.run.containerDirectory) await store.touchEntry(f.context, f.run);
    return result;
  });
  await store.scanExpired(f.context);
  refreshed.mock.restore();
  assert.ok(await fs.stat(f.run.containerDirectory));
  await ageEntry(f.run, 49);
  const rmdir = fs.rmdir;
  let prepared;
  const interleaved = t.mock.method(fs, 'rmdir', async (target, ...args) => {
    if (target === f.run.containerDirectory && !prepared) prepared = await store.createExecution(f.context, f.run);
    return rmdir.call(fs, target, ...args);
  });
  await store.scanExpired(f.context);
  interleaved.mock.restore();
  assert.ok(await fs.stat(prepared.directory));
  assert.ok(await fs.stat(path.join(f.run.entryDirectory, 'current.json')));
  await fs.rm(prepared.directory, { recursive: true });
  await fs.rmdir(f.run.containerDirectory);
  assert.ok(await fs.stat(path.join(f.run.entryDirectory, 'current.json')));
  assert.equal(await absent(f.run.containerDirectory), true);
  await assert.rejects(store.createExecution(f.context, f.run));
  assert.equal(await absent(f.run.containerDirectory), true);
  await store.scanExpired(f.context);
  assert.equal(await absent(f.run.entryDirectory), true, 'A later scan finishes metadata cleanup after the container is already gone.');
});

// Test Value Gate: real scanner processes must exit silently when another scan
// holds the atomic marker, then perform cleanup using the supplied snapshot.
test('independent scans use one non-blocking exclusive marker and stay silent', { timeout: 90000 }, async (t) => {
  const f = await fixture(t, 1);
  await ended(f.run, Date.now() - 2 * hour);
  const marker = path.join(f.context.root, '.scan-lock');
  await fs.mkdir(marker, { mode: 0o700 });
  const hostUrl = new URL('./fixtures/storage-runtime.mjs', import.meta.url).href;
  const launcher = path.join(f.homeRoot, 'scan-entrypoint.mjs');
  await fs.writeFile(launcher, `import { setNativeStorageHost } from ${JSON.stringify(hostUrl)};
setNativeStorageHost(false);
await import(${JSON.stringify(pathToFileURL(scanEntrypoint).href)});
`);
  const snapshot = JSON.stringify({ root: f.context.root, retentionHours: 1, sourceIdentity: identity });
  async function scan() {
    const child = spawn(process.execPath, [launcher, snapshot], { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', (chunk) => chunks.push(chunk));
    const [code] = await once(child, 'close');
    assert.equal(code, 0);
    assert.equal(Buffer.concat(chunks).length, 0);
  }
  await Promise.all([scan(), scan()]);
  assert.ok(await fs.stat(f.run.directory));
  await fs.rmdir(marker);
  await scan();
  assert.equal(await absent(f.run.directory), true);
  assert.equal(await absent(marker), true);

  const gate = path.join(f.homeRoot, 'release');
  const traversalGate = path.join(f.homeRoot, 'start-traversal');
  const wrapper = path.join(f.homeRoot, 'scanner.mjs');
  await fs.writeFile(wrapper, `import fs from 'node:fs/promises';
import { store, setNativeStorageHost } from ${JSON.stringify(hostUrl)};
setNativeStorageHost(false);
const { scanExpired, storeContext } = store;
const options = JSON.parse(process.argv[2]);
async function waitFor(target) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline && !await fs.stat(target).catch(() => null)) await new Promise((resolve) => setTimeout(resolve, 20));
}
const mkdir = fs.mkdir;
fs.mkdir = async (target, ...args) => {
  const result = await mkdir.call(fs, target, ...args);
  // Hold the winner before traversal until the other scanner has exited.
  if (target === ${JSON.stringify(marker)}) await waitFor(${JSON.stringify(traversalGate)});
  return result;
};
const readdir = fs.readdir;
fs.readdir = async (target, ...args) => {
  const result = await readdir.call(fs, target, ...args);
  if (target === options.root) {
    await fs.writeFile(${JSON.stringify(path.join(f.homeRoot, 'entered-'))} + process.pid, '');
    process.send({ type: 'entered' });
    await waitFor(${JSON.stringify(gate)});
  }
  return result;
};
await scanExpired({ ...await storeContext(options), table: [] });
process.disconnect();
`);
  const children = Array.from({ length: 2 }, () => spawn(process.execPath, [wrapper, snapshot], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }));
  let entered;
  const ready = new Promise((resolve) => { entered = resolve; });
  for (const child of children) child.once('message', entered);
  const finished = children.map(async (child) => {
    const output = [];
    child.stdout.on('data', (chunk) => output.push(chunk));
    child.stderr.on('data', (chunk) => output.push(chunk));
    const [code] = await once(child, 'close');
    assert.equal(code, 0);
    assert.equal(Buffer.concat(output).length, 0);
  });
  const release = () => Promise.all([gate, traversalGate].map((target) => fs.writeFile(target, '')));
  t.after(async () => {
    await release().catch(() => {});
    for (const child of children) child.kill();
    await Promise.allSettled(finished);
  });
  try {
    await Promise.race(finished);
    assert.equal((await fs.readdir(f.homeRoot)).filter((name) => name.startsWith('entered-')).length, 0, 'The losing scanner can exit before the winner is ready.');
    await fs.writeFile(traversalGate, '');
    assert.deepEqual(await Promise.race([ready, Promise.all(finished).then(() => { throw new Error('No scanner entered traversal.'); })]), { type: 'entered' });
    assert.equal((await fs.readdir(f.homeRoot)).filter((name) => name.startsWith('entered-')).length, 1, 'Only one simultaneous scanner enters traversal.');
    assert.ok(await fs.stat(marker), 'The scanner that entered is still running.');
  } finally {
    await release();
    await Promise.allSettled(finished);
  }
  await Promise.all(finished);
  assert.equal(await absent(marker), true);
});

// Test Value Gate: legal high-escape message bodies must survive real queue
// reads even when their encoded JSON exceeds the former 64 KiB container.
test('queue reads accept 256 KiB containers and reject one byte beyond', async (t) => {
  const run = { directory: await temporaryHome(t) };
  await fs.mkdir(path.join(run.directory, 'events'));
  const record = { text: '\u0001'.repeat(24576) };
  await fs.writeFile(path.join(run.directory, 'events', 'message.json'), JSON.stringify(record));
  assert.deepEqual(await store.readRecord(run, 'events', 'message.json'), record);
  await fs.writeFile(path.join(run.directory, 'events', 'large.json'), ' '.repeat(262145));
  await assert.rejects(store.readRecord(run, 'events', 'large.json'), { code: 'inputTooLarge' });
});
