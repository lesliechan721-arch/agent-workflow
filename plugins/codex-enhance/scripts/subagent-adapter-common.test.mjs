import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';
import { guideRuntimeScripts } from './fixtures/guide-runtime-resources.mjs';

const scripts = guideRuntimeScripts(import.meta.url);
const require = createRequire(import.meta.url);
const entry = require.resolve('./fixtures/adapter-common.mjs');
const now = Date.UTC(2026, 0, 1);
const month = 30 * 24 * 60 * 60 * 1000;
const testTimeoutMs = process.platform === 'win32' ? 30000 : 10000;

// Test Value Gate: a real adapterMain JSONL connection protects shared stop
// classification and timer boundaries without repeating native backend startup.
async function fixture(t, { deadlineAt = null } = {}) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'aw-adapter-common-'));
  const workspace = path.join(root, 'workspace');
  const directory = path.join(root, 'runtime');
  await fs.mkdir(workspace, { mode: 0o700 });
  await fs.mkdir(directory, { mode: 0o700 });
  const child = spawn(process.execPath, [entry], {
    env: {
      ...process.env,
      AW_SUBAGENT_PROCESS_TOKEN: randomBytes(24).toString('hex'),
      FIXTURE_NOW: String(now),
    },
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  });
  const frames = [];
  const waiters = new Set();
  const clockWaiters = new Map();
  let diagnostic = '';
  let closed = false;
  let sequence = 0;
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { diagnostic += chunk; });
  child.stdin.on('error', () => {});
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    frames.push(JSON.parse(line));
    for (const check of waiters) check();
  });
  child.on('message', (message) => {
    clockWaiters.get(message.id)?.(message);
    clockWaiters.delete(message.id);
  });
  const exit = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => {
      closed = true;
      for (const check of waiters) check();
      resolve({ code, diagnostic });
    });
  });
  t.after(async () => {
    if (!closed) child.kill('SIGKILL');
    child.stdin.destroy();
    if (child.connected) child.disconnect();
    await exit;
    child.stdout.destroy(); child.stderr.destroy();
    await fs.rm(root, { recursive: true, force: true });
  });
  const send = (frame) => child.stdin.write(`${JSON.stringify({ protocolVersion: 5, ...frame })}\n`);
  const waitFor = (type) => new Promise((resolve, reject) => {
    let timer;
    const finish = (error, frame) => {
      clearTimeout(timer); waiters.delete(check);
      if (error) reject(error); else resolve(frame);
    };
    const check = () => {
      const frame = frames.find((value) => value.type === type);
      if (frame) finish(null, frame);
      else if (closed) finish(new Error(`Missing ${type}: ${diagnostic}`));
    };
    waiters.add(check);
    timer = setTimeout(() => finish(new Error(`Missing ${type}: ${diagnostic}`)), testTimeoutMs);
    check();
  });
  const advance = (milliseconds = 0) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { clockWaiters.delete(id); reject(new Error(`Clock did not advance: ${diagnostic}`)); }, testTimeoutMs);
    clockWaiters.set(id, (message) => { clearTimeout(timer); resolve(message); });
    child.send({ id, milliseconds });
  });
  const finish = async () => {
    const result = await waitFor('result');
    child.stdin.destroy();
    if (child.connected) child.disconnect();
    const closed = await exit;
    assert.equal(closed.code, 0, closed.diagnostic);
    assert.equal(frames.filter((frame) => frame.type === 'result').length, 1);
    assert.equal(frames.at(-1).type, 'result');
    return result;
  };
  send({
    type: 'start', run: { id: randomBytes(16).toString('hex'), name: 'lifecycle-fixture', deadlineAt },
    execution: { profile: 'generalTaskProfile', executor: 'fixture' }, mode: 'workspace', workspace,
    prompt: 'Wait for the lifecycle stop.', args: [],
    runtime: { directory, toolkit: {
      command: process.execPath, module: path.join(scripts, 'runtime/adapter-channel.mjs'),
      messageScript: path.join(scripts, 'message.mjs'), mcpScript: path.join(scripts, 'message-mcp.mjs'),
    } },
  });
  return { child, frames, send, waitFor, advance, finish, diagnostics: () => diagnostic };
}

for (const stop of ['requested', 'eof', 'deadline']) test(`adapterMain: ${stop} stops an active run without communication`, { timeout: testTimeoutMs }, async (t) => {
  const run = await fixture(t, { deadlineAt: stop === 'deadline' ? now + 1000 : null });
  assert.equal((await run.waitFor('ready')).communicationSupported, false);
  if (stop === 'requested') run.send({ type: 'stop', reason: 'requested' });
  else if (stop === 'eof') run.child.stdin.end();
  else {
    assert.equal((await run.advance(999)).aborted, false);
    await run.advance(1);
  }
  const closing = await run.waitFor('closing');
  assert.equal(closing.reason, stop === 'eof' ? 'error' : 'cancelled');
  assert.equal((await run.advance()).stopCalls, 1);
  const result = await run.finish();
  assert.equal(result.state, 'unknown');
  assert.equal(result.generationStarted, true);
  assert.equal(result.remoteStopConfirmed, false);
  assert.equal(result.code, stop === 'deadline' ? 'adapterDeadlineExceeded' : stop === 'eof' ? 'channelClosed' : 'remoteStopUnconfirmed');
  assert.equal(run.frames.filter((frame) => frame.type === 'closing').length, 1);
});

test('adapterMain: a 30-day deadline stays open across the timer limit and expires at its fixed time', { timeout: testTimeoutMs }, async (t) => {
  const run = await fixture(t, { deadlineAt: now + month });
  await run.waitFor('ready');
  assert.equal((await run.advance(2147483647)).aborted, false);
  assert.equal((await run.advance(month - 2147483647 - 1)).aborted, false);
  assert.deepEqual(run.frames.map((frame) => frame.type), ['ready']);
  await run.advance(1);
  assert.equal((await run.finish()).code, 'adapterDeadlineExceeded');
  assert.doesNotMatch(run.diagnostics(), /TimeoutOverflowWarning/);
});
