import { nativeTest as test } from './fixtures/native-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { fixture, supported, testTimeoutMs, readCapturedSoFar, waitForCaptured } from './fixtures/adapter-v6.mjs';

// Test Value Gate: capture observation must wait for backend input despite file
// creation or partial-write races, while real I/O and complete JSONL errors fail.
test('capture observation waits for complete backend input and preserves read errors', async (t) => {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'aw-adapter-capture-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const capture = path.join(directory, 'capture.jsonl');
  assert.deepEqual(await readCapturedSoFar(capture), []);
  await fs.writeFile(capture, '');
  assert.deepEqual(await readCapturedSoFar(capture), []);
  await fs.writeFile(capture, '{"metadata":true}\n{"input":');
  assert.deepEqual(await readCapturedSoFar(capture), [{ metadata: true }]);
  let observedMetadata;
  const metadata = new Promise((resolve) => { observedMetadata = resolve; });
  let receivedInput = false;
  const waiting = waitForCaptured(capture, (value) => {
    if (value.metadata) observedMetadata();
    return value.input === 'initial';
  }).then(() => { receivedInput = true; });
  await metadata;
  assert.equal(receivedInput, false);
  await fs.appendFile(capture, '"initial"}\n');
  await waiting;
  assert.equal(receivedInput, true);
  await fs.appendFile(capture, '{broken JSON}\n');
  await assert.rejects(waitForCaptured(capture, () => false), SyntaxError);
  await assert.rejects(waitForCaptured(directory, () => false), { code: 'EISDIR' });
});

test('Codex: a rejected steer at a turn boundary starts one next turn', { skip: !supported, timeout: testTimeoutMs }, async (t) => {
  const f = await fixture(t, 'codex', 'turn race'); const run = f.start(); run.send(f.request); await run.waitFor('ready');
  run.send({ type: 'message', id: 'b'.repeat(32), text: 'Continue the same task.' });
  assert.equal((await run.waitFor('delivery')).status, 'submitted');
  assert.equal((await run.waitFor('result')).state, 'completed'); await run.exit;
  const values = await f.captured();
  assert.equal(values.filter((value) => value.input?.method === 'thread/start').length, 1);
  assert.equal(values.filter((value) => value.input?.method === 'turn/start').length, 2);
});

test('Codex: a lost submission response stays unknown and is not replayed', { skip: !supported, timeout: testTimeoutMs }, async (t) => {
  const f = await fixture(t, 'codex', 'lost response'); const run = f.start(); run.send(f.request); await run.waitFor('ready');
  run.send({ type: 'message', id: 'c'.repeat(32), text: 'Additional input.' });
  assert.equal((await run.waitFor('delivery')).status, 'unknown');
  assert.equal((await run.waitFor('result')).state, 'unknown'); await run.exit;
  const values = await f.captured();
  assert.equal(values.filter((value) => value.input?.method === 'turn/steer').length, 1);
  assert.equal(values.filter((value) => value.input?.method === 'turn/start').length, 1);
});

// Shared stop causes and timing are covered through adapterMain's JSONL entry
// in subagent-adapter-common.test.mjs. Each backend keeps its native stop wire.
for (const backend of ['codex', 'claude']) test(`${backend}: requested stop reaches a waiting backend`, { skip: !supported, timeout: testTimeoutMs }, async (t) => {
  const f = await fixture(t, backend, 'hold');
  const run = f.start(); run.send(f.request);
  assert.equal((await run.waitFor('ready')).initialization.capabilities.communication.status, 'enabled');
  if (backend === 'codex') {
    // Delivery waits for initial turn acceptance and a real steer response.
    // The adapter has therefore received the turn ID before stop arrives.
    const id = 'f'.repeat(32);
    run.send({ type: 'message', id, text: 'Keep waiting for the requested stop.' });
    const delivery = await run.waitFor('delivery');
    assert.equal(delivery.id, id); assert.equal(delivery.status, 'submitted');
  } else await f.waitForCaptured((value) => value.input?.type === 'user');
  run.send({ type: 'stop', reason: 'requested' });
  const result = await run.waitFor('result');
  assert.notEqual(result.state, 'completed');
  assert.equal(result.code, 'remoteStopUnconfirmed');
  assert.equal((await run.exit).code, 0);
  const values = await f.captured();
  if (backend === 'codex') {
    assert.equal(values.filter((value) => value.input?.method === 'turn/start').length, 1);
    assert.equal(values.filter((value) => value.input?.method === 'turn/steer').length, 1);
    assert.equal(values.filter((value) => value.input?.method === 'turn/interrupt').length, 1);
  } else assert.equal(result.backendExitCode, 0);
});

test('Codex: explicit unmappable options fail before starting the backend', { skip: !supported, timeout: testTimeoutMs }, async (t) => {
  const f = await fixture(t); f.request.args = ['--dangerously-bypass-hook-trust'];
  const run = f.start(); run.send(f.request); const result = await run.waitFor('result');
  assert.equal(result.state, 'failed'); assert.equal(result.generationStarted, false); assert.equal(result.code, 'parameterUnavailable');
  assert.equal(run.frames.some((frame) => frame.type === 'ready'), false); await run.exit;
  await assert.rejects(fs.access(f.capture), { code: 'ENOENT' });
});

// Test Value Gate: an EOF during executable negotiation must cancel even a
// live version probe before its own deadline, without starting model input.
test('Codex: EOF cancels executable negotiation before model input', { skip: !supported, timeout: testTimeoutMs }, async (t) => {
  const f = await fixture(t, 'codex', 'hold version');
  const run = f.start();
  run.send(f.request);
  await f.waitForCaptured((value) => value.versionProbe);
  const [{ versionProbe }] = await f.captured();
  t.after(() => {
    try { process.kill(versionProbe, 'SIGKILL'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  });
  const closed = once(run.child, 'close', { signal: AbortSignal.timeout(2000) });
  run.child.stdin.end();
  assert.deepEqual(await closed, [0, null]);
  const { frames } = await run.exit;
  assert.deepEqual(frames.map(({ type, state, code, generationStarted }) => ({ type, state, code, generationStarted })), [
    { type: 'result', state: 'failed', code: 'channelClosed', generationStarted: false },
  ]);
  assert.equal(frames[0].initialization, undefined);
  assert.deepEqual(await f.captured(), [{ versionProbe }]);
  assert.throws(() => process.kill(versionProbe, 0), { code: 'ESRCH' });
});

test('Codex: installed child tools emit one parent message before automatic input', { skip: !supported, timeout: testTimeoutMs }, async (t) => {
  const f = await fixture(t, 'codex', 'child tool'); const run = f.start(); run.send(f.request); await run.waitFor('ready');
  assert.equal((await run.waitFor('message')).text, 'Child question 父消息?');
  run.send({ type: 'message', id: 'd'.repeat(32), text: 'Continue with the accepted scope.' });
  assert.equal((await run.waitFor('delivery')).status, 'submitted');
  const result = await run.waitFor('result');
  assert.equal(result.state, 'completed'); assert.equal(result.generationStarted, true); assert.equal(result.backendExitCode, 0);
  assert.equal((await run.exit).code, 0);
  assert.equal(run.frames.filter((frame) => frame.type === 'message').length, 1);
  assert.equal(run.frames.filter((frame) => frame.type === 'result').length, 1);
  const values = await f.captured(); const tool = values.find((value) => value.toolOutput);
  assert.match(tool.toolOutput, /send_parent: submitted/); assert.equal(tool.toolExitCode, 0);
  assert.equal(values.filter((value) => value.input?.method === 'thread/start').length, 1);
  assert.equal(values.filter((value) => value.input?.method === 'turn/start').length, 1);
  assert.equal(values.filter((value) => value.input?.method === 'turn/steer').length, 1);
});
