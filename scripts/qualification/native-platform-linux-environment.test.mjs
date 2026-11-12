import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { readLinuxStartupEnvironment } from './native-platform-linux-environment.mjs';

const pid = 4242;
const markerEnvironmentVariable = 'AW_PRIVATE_STARTUP_MARKER';
const marker = 'private-exact-value';
const assignment = `${markerEnvironmentVariable}=${marker}`;
const request = (extra = {}) => ({ pid, markerEnvironmentVariable, marker, deadlineAt: Date.now() + 2000, ...extra });
const stat = (ticks = '12345678901234567890', processId = pid) => Buffer.from(
  `${processId} (private ) process (name)) S 1 100 100 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 ${ticks} 4096 1\n`);

function fixtureIO({ environment = Buffer.from(`${assignment}\0`), before = stat(), after = before } = {}) {
  let statReads = 0;
  const streams = [];
  return { streams, createReadStream(file) {
    assert([`/proc/${pid}/stat`, `/proc/${pid}/environ`].includes(file));
    const data = file === `/proc/${pid}/stat` ? statReads++ === 0 ? before : after : environment;
    const stream = data instanceof Error
      ? new Readable({ read() { this.destroy(data); } })
      : Readable.from(Array.isArray(data) ? data : [data], { objectMode: false });
    streams.push(stream);
    return stream;
  } };
}

function pendingStream() {
  const stream = new EventEmitter();
  stream.destroyed = false;
  stream.destroy = () => { stream.destroyed = true; stream.emit('close'); return stream; };
  return stream;
}

async function closed(stream) {
  if (!stream.closed) await once(stream, 'close');
  assert.equal(stream.destroyed, true);
}

// Test Value Gate: only exact environment items can become a matching sample;
// qualification output must not retain environment, marker or stat contents.
test('matches an exact NUL item across chunks and returns only fixed diagnostic metadata', async () => {
  const io = fixtureIO({ environment: [Buffer.from('OTHER=private\0AW_PRIVATE_'),
    Buffer.from('STARTUP_MARKER=private-exact-'), Buffer.from('value\0AFTER=private\0')] });
  const report = await readLinuxStartupEnvironment(request(), io);
  assert.deepEqual(Object.keys(report).sort(), ['binding', 'environmentBytes', 'finishedAt', 'identity',
    'markerMatches', 'source', 'startedAt', 'status']);
  assert.equal(report.source, 'linux-proc-startup-environment');
  assert.equal(report.binding, 'same-proc-starttime-within-read-not-atomic-with-original-ps');
  assert.equal(report.status, 'complete');
  assert.equal(report.markerMatches, true);
  assert.equal(report.identity, 'same');
  assert.equal(report.environmentBytes, Buffer.byteLength(`OTHER=private\0${assignment}\0AFTER=private\0`));
  assert(Number.isFinite(Date.parse(report.startedAt)));
  assert(Date.parse(report.finishedAt) >= Date.parse(report.startedAt));
  for (const secret of [marker, markerEnvironmentVariable, 'private ) process', '12345678901234567890']) {
    assert.equal(JSON.stringify(report).includes(secret), false);
  }
  await Promise.all(io.streams.map(closed));
});

test('uses a real EOF as an item boundary and rejects substrings and argv-like items', async () => {
  for (const [environment, expected] of [
    [assignment, true],
    [`OTHER=x\0${assignment}`, true],
    [`ARGV=tool ${assignment}\0`, false],
    [`X${assignment}\0`, false],
    [`${assignment}-suffix\0`, false],
    [`${markerEnvironmentVariable}=prefix-${marker}\0`, false],
    [`${markerEnvironmentVariable}=wrong\0`, false],
    [`${markerEnvironmentVariable}_OTHER=${marker}\0`, false],
    [`OTHER=${marker}\0`, false],
  ]) {
    const report = await readLinuxStartupEnvironment(request(), fixtureIO({ environment: Buffer.from(environment) }));
    assert.equal(report.status, 'complete');
    assert.equal(report.identity, 'same');
    assert.equal(report.markerMatches, expected);
  }
});

// Test Value Gate: unavailable, incomplete or changed-process evidence must
// remain unknown, even when a complete matching item was already observed.
test('keeps empty and failed environment reads unknown', async () => {
  for (const [environment, status] of [
    [Buffer.alloc(0), 'empty'],
    [Object.assign(new Error('private denied'), { code: 'EACCES' }), 'permission-denied'],
    [Object.assign(new Error('private denied'), { code: 'EPERM' }), 'permission-denied'],
    [Object.assign(new Error('private missing'), { code: 'ENOENT' }), 'not-found'],
    [Object.assign(new Error('private failure'), { code: 'EIO' }), 'read-error'],
  ]) {
    const report = await readLinuxStartupEnvironment(request(), fixtureIO({ environment }));
    assert.equal(report.status, status);
    assert.equal(report.markerMatches, null);
    assert.equal(report.identity, 'same');
    assert.equal(report.environmentBytes, 0);
    assert.equal(JSON.stringify(report).includes('private'), false);
  }
});

test('requires matching stat pid and unchanged field 22 without exposing identity ticks', async () => {
  for (const [before, after, status, identity] of [
    [stat('100'), stat('101'), 'identity-changed', 'changed'],
    [stat(), stat('100', pid + 1), 'identity-unknown', 'unknown'],
    [stat(), stat('invalid'), 'identity-unknown', 'unknown'],
    [Buffer.from('private malformed'), stat(), 'identity-unknown', 'unknown'],
    [stat('100', pid + 1), stat(), 'identity-unknown', 'unknown'],
    [stat(), Object.assign(new Error('private gone'), { code: 'ESRCH' }), 'not-found', 'unknown'],
    [Object.assign(new Error('private denied'), { code: 'EACCES' }), stat(), 'permission-denied', 'unknown'],
    [Buffer.alloc(4096, 65), stat(), 'truncated', 'unknown'],
  ]) {
    const report = await readLinuxStartupEnvironment(request(), fixtureIO({ before, after }));
    assert.equal(report.status, status);
    assert.equal(report.identity, identity);
    assert.equal(report.markerMatches, null);
  }
});

test('does not infer completeness from a stream that closes before EOF', async () => {
  const io = fixtureIO();
  const original = io.createReadStream;
  io.createReadStream = (file, options) => {
    if (file !== `/proc/${pid}/environ`) return original(file, options);
    const stream = pendingStream();
    queueMicrotask(() => { stream.emit('data', Buffer.from(`${assignment}\0`)); stream.emit('close'); });
    return stream;
  };
  const report = await readLinuxStartupEnvironment(request(), io);
  assert.equal(report.status, 'read-error');
  assert.equal(report.markerMatches, null);
  assert.equal(report.environmentBytes, Buffer.byteLength(`${assignment}\0`));
});

// Test Value Gate: exercise the real finite filesystem stream, including one
// overflow byte, rather than only making a synthetic stream claim truncation.
test('caps physical environment reads and distinguishes exact-limit EOF from overflow', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-linux-environment-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'environment');
  for (const size of [65535, 65536, 65537, 131072]) {
    const bytes = Buffer.alloc(size, 120);
    Buffer.from(`${assignment}\0OTHER=`).copy(bytes);
    await fs.writeFile(file, bytes);
    const io = fixtureIO();
    const original = io.createReadStream;
    let environmentStream;
    io.createReadStream = (requestedFile, options) => {
      if (requestedFile !== `/proc/${pid}/environ`) return original(requestedFile, options);
      environmentStream = createReadStream(file, options);
      return environmentStream;
    };
    const report = await readLinuxStartupEnvironment(request(), io);
    assert.equal(report.status, size > 65536 ? 'truncated' : 'complete');
    assert.equal(report.markerMatches, size > 65536 ? null : true);
    assert.equal(report.environmentBytes, Math.min(size, 65536));
    await closed(environmentStream);
    assert(environmentStream.bytesRead <= 65537);
    await Promise.all(io.streams.map(closed));
  }
});

// Test Value Gate: deadline and abort must destroy pending I/O without waiting
// for an uncooperative completion or changing the settled diagnostic object.
test('uses the original absolute deadline after the first stat read', { timeout: 2000 }, async (t) => {
  const controller = new AbortController();
  const startedAt = Date.now();
  const deadlineAt = startedAt + 120;
  const first = pendingStream();
  const environment = pendingStream();
  const release = setTimeout(() => { first.emit('data', stat()); first.emit('end'); }, 80);
  const externalAbort = setTimeout(() => controller.abort(), 160);
  t.after(() => { clearTimeout(release); clearTimeout(externalAbort); });
  let reads = 0;
  const report = await readLinuxStartupEnvironment(request({ deadlineAt, signal: controller.signal }), {
    createReadStream() { return reads++ === 0 ? first : environment; },
  });
  assert.equal(report.status, 'deadline-exceeded');
  assert.equal(report.markerMatches, null);
  assert(Date.parse(report.finishedAt) >= deadlineAt);
  assert.equal(first.destroyed, true);
  if (reads > 1) assert.equal(environment.destroyed, true);
  assert(reads <= 2);
});

test('destroys an aborted stream and ignores late data, EOF and errors', { timeout: 2000 }, async () => {
  const controller = new AbortController();
  const environment = pendingStream();
  const io = fixtureIO();
  const original = io.createReadStream;
  let reached;
  const ready = new Promise(resolve => { reached = resolve; });
  io.createReadStream = (file, options) => {
    if (file !== `/proc/${pid}/environ`) return original(file, options);
    reached();
    return environment;
  };
  const pending = readLinuxStartupEnvironment(request({ signal: controller.signal }), io);
  await ready;
  controller.abort();
  const report = await pending;
  assert.equal(report.status, 'aborted');
  assert.equal(report.markerMatches, null);
  assert.equal(environment.destroyed, true);
  const saved = JSON.stringify(report);
  environment.emit('data', Buffer.from(`${assignment}\0`));
  environment.emit('end');
  environment.emit('error', new Error('private late error'));
  environment.emit('close');
  assert.equal(JSON.stringify(report), saved);
  assert.equal(Object.isFrozen(report), true);
});

test('rejects invalid input, expired deadlines and pre-aborted requests without filesystem access', async () => {
  const controller = new AbortController();
  controller.abort();
  const io = { createReadStream() { assert.fail('filesystem access is not permitted'); } };
  for (const extra of [{ pid: 0 }, { pid: -1 }, { pid: Number.MAX_SAFE_INTEGER + 1 }, { pid: '4242' },
    { marker: '' }, { marker: 'private\0value' }, { marker: '\ud800' },
    { markerEnvironmentVariable: 'BAD=NAME' }, { markerEnvironmentVariable: '' },
    { marker: 'x'.repeat(65536) }, { deadlineAt: NaN }, { signal: {} }]) {
    const report = await readLinuxStartupEnvironment(request(extra), io);
    assert.equal(report.status, 'invalid-input');
    assert.equal(report.markerMatches, null);
    assert.equal(report.environmentBytes, 0);
  }
  assert.equal((await readLinuxStartupEnvironment(request({ deadlineAt: Date.now() - 1 }), io)).status, 'deadline-exceeded');
  assert.equal((await readLinuxStartupEnvironment(request({ signal: controller.signal }), io)).status, 'aborted');
});

// A real reader contract check on an owned Linux child. This supplies no native
// client root-cause or provider qualification evidence.
test('reads the startup environment of a short-lived owned Linux process', {
  skip: process.platform !== 'linux', timeout: 10000,
}, async () => {
  const child = spawn(process.execPath, ['-e', "process.stdout.write('ready\\n'); setTimeout(() => process.exit(0), 4000);"], {
    env: { [markerEnvironmentVariable]: marker }, stdio: ['ignore', 'pipe', 'ignore'],
  });
  const exited = new Promise(resolve => {
    child.once('exit', resolve);
    child.once('error', resolve);
  });
  try {
    await new Promise((resolve, reject) => {
      child.stdout.once('data', resolve);
      child.once('error', reject);
      child.once('exit', () => reject(new Error('owned reader fixture exited before ready')));
    });
    const report = await readLinuxStartupEnvironment(request({ pid: child.pid, deadlineAt: Date.now() + 1000 }));
    assert.equal(report.status, 'complete');
    assert.equal(report.identity, 'same');
    assert.equal(report.markerMatches, true);
    assert(report.environmentBytes > 0 && report.environmentBytes <= 65536);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
    child.stdout.destroy();
  }
});
