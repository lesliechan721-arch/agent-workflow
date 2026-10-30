import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { atomicJson, readJson } from '../skills/codex-subagent-guide/scripts/runtime/files.mjs';
import { processIdentity } from '../skills/codex-subagent-guide/scripts/runtime/processes.mjs';
import * as store from '../skills/codex-subagent-guide/scripts/runtime/store.mjs';
import { guideRuntimeScripts } from './fixtures/guide-runtime-resources.mjs';

const hour = 3600000;
const identity = { sourceId: 'fixture', sourceIdentity: 'fixture-source', pluginId: 'fixture/codex-enhance', pluginName: 'codex-enhance',
  pluginVersion: '1.0.0', platform: 'codex', scope: 'user', configScope: 'user', artifactId: 'guide', skillKey: 'codex-subagent-guide' };
const absent = (target) => fs.lstat(target).then(() => false, (error) => { if (error.code === 'ENOENT') return true; throw error; });

async function fixture(t, retentionHours = 24) {
  const homeRoot = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'aw-storage-'));
  t.after(() => fs.rm(homeRoot, { recursive: true, force: true }));
  const context = await store.storeContext({ homeRoot, retentionHours, sourceIdentity: identity });
  const run = await store.createRun(context, 'fixture', homeRoot, identity);
  await store.publishRun(context, run);
  return { homeRoot, context, run };
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
// execution; missing current content must not fall back to a prior result.
test('fixed entry publishes complete executions and preserves concrete worker paths', async (t) => {
  const f = await fixture(t);
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
  await fs.rm(second.directory, { recursive: true });
  await assert.rejects(store.openRun(f.context, f.run.handle));
  assert.ok(await fs.stat(f.run.directory));
});

// Test Value Gate: current configuration, exact TTL boundaries and disabled or
// invalid settings determine logical expiry without modifying saved state.
test('expiry follows a safe current configuration snapshot and source identity', async (t) => {
  const { context, run } = await fixture(t);
  const at = Date.now() - 30 * hour;
  await ended(run, at);
  assert.equal(store.expired(run.meta, at + 24 * hour - 1, context), false);
  assert.equal(store.expired(run.meta, at + 24 * hour, context), true);
  assert.equal(store.expired(run.meta, at + 30 * hour, { ...context, retentionHours: 48 }), false);
  for (const value of [0, -1, NaN, Infinity, '24', null, 0.5, Number.MAX_SAFE_INTEGER]) {
    assert.equal(store.expired(run.meta, Date.now(), { ...context, retentionHours: value }), false, String(value));
    await store.scanExpired({ ...context, retentionHours: value });
    assert.ok(await fs.stat(run.directory));
  }
  assert.equal(store.expired(run.meta, Date.now(), { ...context, sourceIdentity: undefined }), false);
  assert.equal(store.expired(run.meta, Date.now(), { ...context, sourceIdentity: { ...identity, sourceIdentity: 'foreign' } }), false);
  assert.equal(store.expired(run.meta, Date.now(), { ...context, sourceIdentity: { ...identity, pluginVersion: '2.0.0' } }), true);
  assert.equal((await readJson(path.join(run.directory, 'owner.json'))).terminalAt, at);
  await store.scanExpired({ ...context, sourceIdentity: { ...identity, sourceIdentity: 'foreign' } });
  assert.ok(await fs.stat(run.directory));
});

// Test Value Gate: clearing expired execution data and clearing entry metadata
// in separate rounds protects recovery preparation and preserves unknown nodes.
test('scans separate execution deletion from strictly older empty metadata', async (t) => {
  const f = await fixture(t, 1);
  await ended(f.run, Date.now() - 2 * hour);
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
    const g = await fixture(t, ttl);
    await fs.rm(g.run.directory, { recursive: true });
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
  const maximum = await fixture(t, Math.floor(Number.MAX_SAFE_INTEGER / hour));
  await fs.rm(maximum.run.directory, { recursive: true });
  await fs.utimes(path.join(maximum.run.entryDirectory, 'current.json'), new Date(0), new Date(0));
  const largestClock = t.mock.method(Date, 'now', () => Number.MAX_SAFE_INTEGER);
  await store.scanExpired(maximum.context);
  assert.ok(await fs.stat(maximum.run.entryDirectory), 'The maximum legal TTL does not overflow its doubled metadata interval.');
  largestClock.mock.restore();
  const g = await fixture(t);
  await fs.rm(g.run.directory, { recursive: true });
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
  await ended(f.run, Date.now() - 2 * hour, await processIdentity(process.pid));
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
  const entrypoint = path.join(guideRuntimeScripts(import.meta.url), 'scan-expired.mjs');
  const snapshot = JSON.stringify({ root: f.context.root, retentionHours: 1, sourceIdentity: identity });
  async function scan() {
    const child = spawn(process.execPath, [entrypoint, snapshot], { stdio: ['ignore', 'pipe', 'pipe'] });
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
  const wrapper = path.join(f.homeRoot, 'scanner.mjs');
  const storeUrl = new URL('../skills/codex-subagent-guide/scripts/runtime/store.mjs', import.meta.url).href;
  await fs.writeFile(wrapper, `import fs from 'node:fs/promises';
import { scanExpired, storeContext } from ${JSON.stringify(storeUrl)};
const options = JSON.parse(process.argv[2]);
const readdir = fs.readdir;
fs.readdir = async (target, ...args) => {
  const result = await readdir.call(fs, target, ...args);
  if (target === options.root) {
    await fs.writeFile(${JSON.stringify(path.join(f.homeRoot, 'entered-'))} + process.pid, '');
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline && !await fs.stat(${JSON.stringify(gate)}).catch(() => null)) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return result;
};
await scanExpired(await storeContext(options));
`);
  const children = Array.from({ length: 2 }, () => spawn(process.execPath, [wrapper, snapshot], { stdio: ['ignore', 'pipe', 'pipe'] }));
  t.after(() => { for (const child of children) child.kill(); });
  const finished = children.map(async (child) => {
    const output = [];
    child.stdout.on('data', (chunk) => output.push(chunk));
    child.stderr.on('data', (chunk) => output.push(chunk));
    const [code] = await once(child, 'close');
    assert.equal(code, 0);
    assert.equal(Buffer.concat(output).length, 0);
  });
  await Promise.race(finished);
  assert.equal((await fs.readdir(f.homeRoot)).filter((name) => name.startsWith('entered-')).length, 1, 'Only one simultaneous scanner enters traversal.');
  assert.ok(await fs.stat(marker), 'The scanner that entered is still running.');
  await fs.writeFile(gate, '');
  await Promise.all(finished);
  assert.equal(await absent(marker), true);
});

// Test Value Gate: legal high-escape message bodies must survive real queue
// reads even when their encoded JSON exceeds the former 64 KiB container.
test('queue reads accept 256 KiB containers and reject one byte beyond', async (t) => {
  const { run } = await fixture(t);
  const record = { text: '\u0001'.repeat(24576) };
  await atomicJson(path.join(run.directory, 'events', 'message.json'), record);
  assert.deepEqual(await store.readRecord(run, 'events', 'message.json'), record);
  await fs.writeFile(path.join(run.directory, 'events', 'large.json'), ' '.repeat(262145));
  await assert.rejects(store.readRecord(run, 'events', 'large.json'), { code: 'inputTooLarge' });
});
