import test from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { qualificationAdapter, waitForCommunication } from './fixtures/windows-qualification.mjs';
import { createFrameDecoder, createFrameWriter, createProtocolState, validateFrame } from '../skills/codex-subagent-guide/scripts/runtime/protocol.mjs';
import { LIMITS, validateRequest } from '../skills/codex-subagent-guide/scripts/runtime/contracts.mjs';

const start = () => ({
  protocolVersion: 5, type: 'start', run: { id: '1'.repeat(11), name: 'agent-test', deadlineAt: null },
  execution: { executor: 'fixture' }, mode: 'workspace', workspace: process.cwd(), prompt: '原始任务\r\n😀', args: [], communication: true,
  runtime: { directory: process.cwd(), toolkit: { module: import.meta.filename, command: process.execPath, messageScript: import.meta.filename, mcpScript: import.meta.filename } },
});
const initialization = (communication) => ({ environment: { status: 'available' }, capabilities: { communication } });
const ready = (enabled = true) => ({ protocolVersion: 5, type: 'ready', initialization: initialization(enabled ? { status: 'enabled', transport: 'mcp', passiveDelivery: 'in-turn' } : { status: 'unsupported' }) });
const input = (id = '2'.repeat(32), text = '父消息😀') => ({ protocolVersion: 5, type: 'message', id, text });
const result = () => ({ protocolVersion: 5, type: 'result', state: 'completed', generationStarted: true, backendExitCode: 0, text: '最终结果。' });

// Test Value Gate: execute the qualification's adapter on every OS so its actual
// ready/result frames cannot drift from the production protocol unnoticed.
test('Windows qualification adapter emits valid v5 initialization and stops its backend', { timeout: 10000 }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-qualification-protocol-'));
  const child = spawn(process.execPath, ['--input-type=module', '-e', qualificationAdapter], {
    env: { ...process.env, FIXTURE_OBSERVED: path.join(directory, 'observed.json'), FIXTURE_FINISH: path.join(directory, 'finish') },
    stdio: ['pipe', 'pipe', 'pipe'], timeout: 8000,
  });
  const closed = once(child, 'close'); closed.catch(() => {});
  t.after(async () => { child.kill(); await closed.catch(() => {}); await fs.rm(directory, { recursive: true, force: true }); });
  child.stdin.on('error', () => {});
  const frames = [];
  child.stdin.write(JSON.stringify(start()) + '\n');
  for await (const line of readline.createInterface({ input: child.stdout })) {
    const frame = validateFrame(JSON.parse(line), 'adapter');
    frames.push(frame);
    if (frame.type === 'ready') child.stdin.write('{"protocolVersion":5,"type":"stop","reason":"requested"}\n');
  }
  assert.deepEqual(await closed, [0, null]);
  assert.deepEqual(frames.map((frame) => frame.type), ['ready', 'closing', 'result']);
  assert.deepEqual(frames[0], ready());
  assert.equal(frames[2].state, 'cancelled');
  assert.equal(frames[2].backendExitCode, 0);
});

// Test Value Gate: a terminal initialization failure must surface its status
// immediately instead of being converted into a minute-long command timeout.
test('qualification readiness follows pending runs and reports terminal failure immediately', async () => {
  const pending = { exit: 1, handle: 'fixture', stdout: 'starting fixture\n', stderr: '<diagnostic code="startupNotReady">\nInitialization is pending.\n</diagnostic>\n' };
  let calls = 0;
  await waitForCommunication(pending, async (args) => {
    calls++; assert.equal(args[2], 'fixture');
    return { exit: 0, stdout: 'ready fixture communication=true\n' };
  });
  assert.equal(calls, 1);
  for (const state of ['failed', 'cancelled', 'unknown', 'completed']) {
    calls = 0;
    await assert.rejects(waitForCommunication(pending, async () => {
      calls++;
      return { exit: 0, stdout: `<result state="${state}" communication="true" code="protocolInvalid">\nready fixture communication=true\n</result>\n` };
    }), { code: 'readinessFailed', details: { state, runtimeCode: 'protocolInvalid' } });
    assert.equal(calls, 1);
  }
  await assert.rejects(waitForCommunication({ exit: 1, stdout: 'start_failed fixture state=failed code=workerLost\n' }, () => assert.fail('A failed start must not poll.')), {
    code: 'readinessFailed', details: { state: 'failed', runtimeCode: 'workerLost' },
  });
  await assert.rejects(waitForCommunication(pending, () => assert.fail('An expired wait must not poll.'), { timeoutMs: 0 }), { code: 'commandTimeout' });
});

// Test Value Gate: public wire helpers protect exact Unicode bytes, strict v5
// fields, ordered lifecycle, message identity, and cancellation under backpressure.
test('v5 decoder preserves byte fragments, CRLF, multiple frames, and original text', () => {
  const frames = [start(), input()]; const received = [];
  const decoder = createFrameDecoder({ direction: 'worker', onFrame: (frame) => received.push(frame) });
  const wire = Buffer.from(frames.map((frame) => JSON.stringify(frame)).join('\r\n') + '\r\n');
  for (const byte of wire) decoder.push(Buffer.from([byte]));
  decoder.end();
  assert.deepEqual(received, frames);
  assert.equal(received[0].run.deadlineAt, null);
  assert.equal(Object.hasOwn(LIMITS, 'deadlineMs'), false);
});

test('v5 decoder rejects malformed bytes, records, partial EOF, and encoded frame overflow', () => {
  for (const bytes of [Buffer.from('\ufeff{}\n'), Buffer.from('\n'), Buffer.from('null\n'), Buffer.from('[]\n'), Buffer.from('{}\n'), Buffer.from([0xc0, 0x80, 0x0a])]) {
    const decoder = createFrameDecoder({ direction: 'adapter', onFrame() {} });
    assert.throws(() => decoder.push(bytes));
  }
  const partial = createFrameDecoder({ direction: 'adapter', onFrame() {} });
  partial.push(Buffer.from(JSON.stringify(ready())));
  assert.throws(() => partial.end(), { code: 'protocolInvalid' });
  const oversized = createFrameDecoder({ direction: 'adapter', onFrame() {} });
  assert.throws(() => oversized.push(Buffer.from(`${JSON.stringify(ready())}${' '.repeat(4096)}\n`)), { code: 'protocolTooLarge' });
});

test('v5 shape validation rejects unknown fields, old requests, unsafe IDs, names, and result evidence', () => {
  for (const mutate of [
    (value) => { value.protocolVersion = 4; },
    (value) => { value.preview = true; },
    (value) => { value.run.id = 'A'.repeat(32); },
    (value) => { value.run.name = ' space'; },
    (value) => { value.run.name = '中文'; },
    (value) => { delete value.run.deadlineAt; },
    (value) => { value.run.deadlineAt = -1; },
    (value) => { value.execution.model = 'bad\nmodel'; },
    (value) => { value.execution.extra = true; },
    (value) => { value.execution.profile = 'generalTaskProfile'; },
    (value) => { delete value.execution.executor; },
    (value) => { value.runtime.toolkit.extra = '/tmp/example'; },
    (value) => { value.fileSelectors = []; },
    (value) => { value.workspace = 'relative'; },
    (value) => { value.prompt = '\ud800'; },
    (value) => { delete value.communication; },
    (value) => { value.communication = 'true'; },
    (value) => { value.permissionMode = 'skip'; },
  ]) {
    const frame = start(); mutate(frame); assert.throws(() => validateRequest(frame));
  }
  for (const mutate of [
    (value) => { value.backendExitCode = null; },
    (value) => { value.backendExitCode = 1; },
    (value) => { value.generationStarted = false; },
    (value) => { value.text = ' '; },
    (value) => { value.state = 'failed'; },
    (value) => { value.code = 'unsafe-code'; },
    (value) => { value.message = 'x'.repeat(4097); },
  ]) {
    const frame = result(); mutate(frame); assert.throws(() => validateFrame(frame, 'adapter'));
  }
  assert.throws(() => validateFrame({ ...ready(), unexpected: true }, 'adapter'));
  assert.throws(() => validateFrame({ protocolVersion: 5, type: 'poll' }, 'worker'));
});

// Test Value Gate: initialization is a strict public contract. Partial failures
// must preserve unknown capabilities and cannot rewrite an earlier ready frame.
test('initialization validates environment, named capabilities, and immutable ready evidence', () => {
  for (const invalid of [
    { environment: { status: 'pending' }, capabilities: {} },
    { environment: { status: 'available', code: 'unexpected' }, capabilities: {} },
    { environment: { status: 'unavailable' }, capabilities: {} },
    { environment: { status: 'available' }, capabilities: { extra: {} } },
    { environment: { status: 'available' }, capabilities: {} },
    { environment: { status: 'unavailable', code: 'executableNotFound' }, capabilities: { communication: { status: 'unsupported' } } },
  ]) assert.throws(() => validateFrame({ protocolVersion: 5, type: 'ready', initialization: invalid }, 'adapter'), { code: 'protocolInvalid' });
  assert.throws(() => validateFrame({ protocolVersion: 5, type: 'ready', communication: { status: 'unsupported' } }, 'adapter'));
  for (const environment of [{ status: 'available' }, { status: 'unavailable', code: 'executableNotFound' }]) {
    const failed = { ...result(), state: 'failed', generationStarted: false, backendExitCode: null, text: '', code: 'initializationFailed', initialization: { environment, capabilities: {} } };
    const state = createProtocolState(); state.acceptWorker(start()); state.acceptAdapter(failed);
    assert.deepEqual(state.initialization, failed.initialization);
    assert.equal(state.communication, null);
  }
  assert.throws(() => validateFrame({ ...result(), initialization: { environment: { status: 'unavailable', code: 'executableNotFound' }, capabilities: {} } }, 'adapter'));
  assert.throws(() => validateFrame({ ...result(), state: 'failed', generationStarted: false, text: '', code: 'initializationFailed',
    initialization: { environment: { status: 'unavailable', code: 'executableNotFound' }, capabilities: ready().initialization.capabilities } }, 'adapter'), { code: 'protocolInvalid' });
  const state = createProtocolState(); state.acceptWorker(start()); state.acceptAdapter(ready());
  state.acceptAdapter({ protocolVersion: 5, type: 'closing', reason: 'completed' });
  assert.throws(() => state.acceptAdapter({ ...result(), initialization: initialization({ status: 'unsupported' }) }), { code: 'protocolInvalid' });
  assert.throws(() => state.acceptAdapter({ ...result(), initialization: { environment: { status: 'available' }, capabilities: {} } }), { code: 'protocolInvalid' });
  state.acceptAdapter({ ...result(), initialization: ready().initialization });
});

test('ready describes exact capabilities and rejects disabled mismatches and invalid diagnostics', () => {
  for (const transport of ['mcp', 'command']) for (const passiveDelivery of ['in-turn', 'turn-boundary', 'none']) {
    const communication = { status: 'enabled', transport, passiveDelivery };
    assert.deepEqual(validateFrame({ ...ready(), initialization: initialization(communication) }, 'adapter').initialization.capabilities.communication, communication);
  }
  for (const communication of [
    { status: 'disabled', activeReceive: false }, { status: 'unsupported', transport: 'mcp' },
    { status: 'enabled', transport: 'mcp', passiveDelivery: 'none', activeReceive: false },
    { status: 'enabled', transport: 'stdio', passiveDelivery: 'in-turn', activeReceive: true },
    { status: 'enabled', transport: 'mcp', passiveDelivery: 'in-turn', activeReceive: true },
    { status: 'enabled', transport: 'command' },
  ]) assert.throws(() => validateFrame({ ...ready(), initialization: initialization(communication) }, 'adapter'), { code: 'protocolInvalid' });
  assert.throws(() => validateFrame({ protocolVersion: 5, type: 'ready', communicationSupported: true }, 'adapter'));
  for (const diagnostics of [[{ code: 'warning', message: 'Safe reason.', value: 'private' }], [{ code: 'unsafe-code', message: 'Reason.' }], [{ code: 'warning', field: 'bad\nfield', message: 'Reason.' }]]) {
    assert.throws(() => validateFrame({ ...ready(), diagnostics }, 'adapter'));
  }
  const diagnostics = [{ code: 'profileFieldIgnored', field: 'features.unknown', message: 'This field is not supported.' }];
  assert.deepEqual(validateFrame({ ...ready(), diagnostics }, 'adapter').diagnostics, diagnostics);
  const disabled = createProtocolState(); disabled.acceptWorker({ ...start(), communication: false });
  assert.throws(() => disabled.acceptAdapter(ready()));
  assert.throws(() => disabled.acceptAdapter(ready(false)));
  disabled.acceptAdapter({ ...ready(), initialization: initialization({ status: 'disabled' }) });
  assert.throws(() => disabled.acceptWorker(input()));
});

test('both message directions enforce 4096 UTF-8 bytes without truncating or normalizing', () => {
  const text = '😀'.repeat(1024);
  assert.equal(validateFrame(input(undefined, text), 'worker').text, text);
  assert.equal(validateFrame({ protocolVersion: 5, type: 'message', text }, 'adapter').text, text);
  for (const invalid of [`${text}x`, ' \r\n', 'contains\0nul', '\ud800']) {
    assert.throws(() => validateFrame(input(undefined, invalid), 'worker'));
    assert.throws(() => validateFrame({ protocolVersion: 5, type: 'message', text: invalid }, 'adapter'));
  }
});

test('connection state enforces ready, delivery association, closing, and unique final result', () => {
  const state = createProtocolState();
  assert.throws(() => state.acceptWorker(input()));
  state.acceptWorker(start());
  assert.throws(() => state.acceptAdapter({ protocolVersion: 5, type: 'message', text: 'early' }));
  state.acceptAdapter(ready());
  assert.throws(() => state.acceptAdapter(ready()));
  for (let index = 0; index < 100; index++) {
    const id = index.toString(16).padStart(32, '0'); state.acceptWorker(input(id, 'same text'));
    state.acceptAdapter({ protocolVersion: 5, type: 'delivery', id, status: 'submitted' });
  }
  assert.throws(() => state.acceptWorker(input('0'.repeat(32))));
  assert.throws(() => state.acceptAdapter({ protocolVersion: 5, type: 'delivery', id: '0'.repeat(32), status: 'submitted' }));
  assert.throws(() => state.acceptAdapter({ protocolVersion: 5, type: 'delivery', id: 'f'.repeat(32), status: 'submitted' }));
  assert.throws(() => state.acceptAdapter(result()));
  state.acceptAdapter({ protocolVersion: 5, type: 'closing', reason: 'completed' });
  assert.throws(() => state.acceptAdapter({ protocolVersion: 5, type: 'message', text: 'late' }));
  state.acceptWorker(input('e'.repeat(32)));
  state.acceptAdapter({ protocolVersion: 5, type: 'delivery', id: 'e'.repeat(32), status: 'notSubmitted', code: 'runClosed' });
  state.acceptAdapter(result());
  assert.throws(() => state.acceptAdapter(result()));
  assert.throws(() => state.acceptWorker({ protocolVersion: 5, type: 'stop', reason: 'requested' }));
});

test('false capability and initialization exceptions preserve actual evidence', () => {
  const state = createProtocolState(); state.acceptWorker(start()); state.acceptAdapter(ready(false));
  assert.throws(() => state.acceptWorker(input()));
  assert.throws(() => state.acceptAdapter({ protocolVersion: 5, type: 'message', text: 'unexpected' }));
  for (const frame of [
    { ...result(), state: 'failed', generationStarted: false, backendExitCode: null, text: '', code: 'initializationFailed' },
    { ...result(), state: 'unknown', generationStarted: null, backendExitCode: null, text: '', code: 'protocolInvalid' },
  ]) {
    const connection = createProtocolState(); connection.acceptWorker(start()); connection.acceptAdapter(frame);
    assert.equal(connection.communication, null);
  }
  const bundle = start(); bundle.mode = 'bundle'; bundle.fileSelectors = []; bundle.fileResolver = { command: process.execPath, args: [import.meta.filename] };
  const connection = createProtocolState(); connection.acceptWorker(bundle); assert.throws(() => connection.acceptAdapter(ready(true)));
});

test('independent read loop accepts stop while serial output is blocked', async () => {
  let release; const output = [];
  const destination = new Writable({ highWaterMark: 1, write(bytes, encoding, callback) { output.push(bytes); release = callback; } });
  const writer = createFrameWriter(destination, { direction: 'adapter' });
  const sending = writer.write(ready());
  await Promise.resolve();
  let stop;
  const decoder = createFrameDecoder({ direction: 'worker', onFrame: (frame) => { stop = frame; } });
  decoder.push(Buffer.from('{"protocolVersion":5,"type":"stop","reason":"requested"}\n'));
  assert.equal(stop.reason, 'requested');
  release(); await sending;
  assert.deepEqual(JSON.parse(Buffer.concat(output).toString()), ready());
  destination.destroy();
});

test('serial writer preserves line order and rejects all pending writes on close', async () => {
  let blocked;
  const destination = new Writable({ write(bytes, encoding, callback) { blocked = callback; } });
  const writer = createFrameWriter(destination, { direction: 'adapter' });
  const writes = [writer.write(ready()), writer.write({ protocolVersion: 5, type: 'closing', reason: 'completed' })];
  await Promise.resolve();
  const settled = Promise.allSettled(writes); writer.close();
  assert.deepEqual((await settled).map((value) => value.status), ['rejected', 'rejected']);
  blocked(); destination.destroy();
});

test('asynchronous frame handlers report failure without blocking later control frames', async () => {
  let rejectHandler; const observed = []; const failures = [];
  const decoder = createFrameDecoder({ direction: 'worker', onError: (error) => failures.push(error), onFrame(frame) {
    observed.push(frame.type);
    if (frame.type === 'start') return new Promise((_resolve, reject) => { rejectHandler = reject; });
  } });
  decoder.push(Buffer.from(`${JSON.stringify(start())}\n{"protocolVersion":5,"type":"stop","reason":"requested"}\n`));
  assert.deepEqual(observed, ['start', 'stop']);
  const failure = new Error('The fake task failed.'); rejectHandler(failure);
  await Promise.resolve(); assert.deepEqual(failures, [failure]);
});
