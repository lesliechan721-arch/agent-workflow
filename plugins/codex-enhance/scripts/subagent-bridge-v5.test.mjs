import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { channel } from 'node:diagnostics_channel';
import { createChildBridge, createChildChannel, invokeChildTool } from '../skills/codex-subagent-guide/scripts/runtime/adapter-channel.mjs';
import { protectPrivatePath } from '../skills/codex-subagent-guide/scripts/runtime/platform.mjs';
import { runMessage } from '../skills/codex-subagent-guide/scripts/message.mjs';
import { runMessageMcp } from '../skills/codex-subagent-guide/scripts/message-mcp.mjs';
import { messageBodies } from './fixtures/message-bodies.mjs';

const require = createRequire(import.meta.url);
const messageScript = require.resolve('../skills/codex-subagent-guide/scripts/message.mjs');
const mcpScript = require.resolve('../skills/codex-subagent-guide/scripts/message-mcp.mjs');
const scripts = path.dirname(messageScript);
const windows = process.platform === 'win32';
const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const id = (value) => value.toString(16).padStart(32, '0');
async function until(predicate, milliseconds = 3000) {
  const expires = Date.now() + milliseconds;
  while (!await predicate()) { if (Date.now() >= expires) throw new Error('The fixture condition was not reached.'); await pause(10); }
}

function caseDiagnostics(t) {
  const began = performance.now(); const events = [];
  return {
    note(phase, values = {}) {
      const event = { phase, elapsedMs: Math.round(performance.now() - began), ...values };
      events.push(event);
      if (process.env.AW_SUBAGENT_COMMUNICATION_DIAGNOSTICS === '1') t.diagnostic(`AW_SUBAGENT_COMMUNICATION_TEST ${JSON.stringify(event)}`);
    },
    snapshot(values = {}) { return JSON.stringify({ events, ...values }); },
  };
}

function observeBridge(t) {
  const diagnostic = caseDiagnostics(t); const events = []; const waiters = new Set(); const listeners = new Set();
  const source = channel('aw.subagent.bridge');
  const observed = (event) => {
    if (event.phase === 'scanCompleted') return;
    events.push(event);
    diagnostic.note(event.phase, event);
    for (const listener of listeners) listener(event);
    for (const waiter of waiters) {
      if (waiter.matches(event)) { waiters.delete(waiter); clearTimeout(waiter.timer); waiter.resolve(event); }
      else waiter.progress();
    }
  };
  source.subscribe(observed);
  t.after(() => { source.unsubscribe(observed); for (const waiter of waiters) clearTimeout(waiter.timer); });
  return {
    note: diagnostic.note,
    listen(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    wait(phase, predicate = () => true) {
      const matches = (event) => event.phase === phase && predicate(event);
      const event = events.find(matches);
      if (event) return Promise.resolve(event);
      return new Promise((resolve, reject) => {
        const waiter = { matches, resolve, timer: null, progress() {
          clearTimeout(waiter.timer);
          waiter.timer = setTimeout(() => { waiters.delete(waiter); reject(new Error(`Bridge phase ${phase} made no progress. ${diagnostic.snapshot()}`)); }, windows ? 20000 : 3000);
        } };
        waiter.progress();
        waiters.add(waiter);
      });
    },
  };
}

// Queue limits and allocation do not require ACL or child process round trips.
function channelFixture(t, options = {}) {
  const messages = [];
  const bridge = createChildChannel({ emitParentMessage: async (text) => { messages.push(text); }, ...options });
  t.after(() => bridge.close('completed'));
  return { bridge, messages, invoke: (operation, values = {}) => bridge.handleRequest({ operation, ...values }) };
}

// Test Value Gate: run installed helper entrypoints in private temporary resources.
// Observe messages and deliveries to protect one scheduler across MCP, scripts,
// automatic submission, cancellation, and resource cleanup without real models.
async function fixture(t, options = {}) {
  const observation = observeBridge(t);
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'aw-child-bridge-'));
  await protectPrivatePath(root, 'directory');
  let bridge;
  t.after(async () => { try { await bridge?.close('completed'); } finally { await fs.rm(root, { recursive: true, force: true }); } });
  const installed = path.join(root, "moved ' install", 'scripts');
  await fs.mkdir(path.join(installed, 'runtime'), { recursive: true });
  await fs.mkdir(path.join(installed, 'file-selection'));
  for (const name of ['runtime/adapter-channel.mjs', 'runtime/contracts.mjs', 'runtime/files.mjs', 'runtime/platform.mjs', 'file-selection/contracts.mjs']) await fs.copyFile(path.join(scripts, name), path.join(installed, name));
  for (const entry of [messageScript, mcpScript]) await fs.copyFile(entry, path.join(installed, path.basename(entry)));
  const toolkit = { module: path.join(installed, 'runtime/adapter-channel.mjs'), command: process.execPath, messageScript: path.join(installed, 'message.mjs'), mcpScript: path.join(installed, 'message-mcp.mjs') };
  const messages = [];
  bridge = await createChildBridge({ directory: path.join(root, 'bridge'), deadlineAt: null, toolkit, emitParentMessage: async (text) => { messages.push(text); }, ...options });
  const bindingFile = bridge.script.args[2];
  const invoke = (operation, values = {}) => invokeChildTool({ bindingFile, operation, ...values });
  const env = { ...process.env, HOME: root, AW_HOME: root, AW_CODEX_HOME: root, AW_CLAUDE_HOME: root };
  const preload = path.join(root, 'trace-bridge.mjs');
  await fs.writeFile(preload, "import { channel } from 'node:diagnostics_channel'; import { writeSync } from 'node:fs'; channel('aw.subagent.bridge').subscribe((event) => writeSync(3, JSON.stringify(event) + '\\n'));\n");
  const execute = (args, input, { keepStdinOpen = false } = {}) => new Promise((resolve, reject) => {
    const child = spawn(bridge.script.command, ['--import', pathToFileURL(preload).href, ...bridge.script.args, ...args], { shell: false, cwd: root, env, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
    let phase = 'spawned'; let trace = ''; let timer; let requestId;
    const progress = (event) => {
      phase = event.phase; observation.note(`script.${phase}`, { operation: args[0], pid: child.pid, ...event });
      if (event.requestId) requestId = event.requestId;
      clearTimeout(timer);
      // A native ACL phase has a 15s platform bound. Allow its error to return
      // before the fixture watchdog, and reset only on actual phase progress.
      timer = setTimeout(() => { child.kill(); reject(new Error(`The child script stopped at ${phase}; operation=${args[0]}, pid=${child.pid}, requestId=${requestId ?? 'unpublished'}.`)); }, windows ? 17000 : 5000);
    };
    const stopObserving = observation.listen((event) => {
      if (requestId && event.requestId === requestId) progress({ ...event, phase: `bridge.${event.phase}` });
    });
    progress({ phase });
    child.stdio[3].setEncoding('utf8'); child.stdio[3].on('data', (data) => {
      trace += data; let newline;
      while ((newline = trace.indexOf('\n')) >= 0) { progress(JSON.parse(trace.slice(0, newline))); trace = trace.slice(newline + 1); }
    });
    const stdout = []; const stderr = [];
    child.stdout.on('data', (bytes) => stdout.push(bytes)); child.stderr.on('data', (bytes) => stderr.push(bytes));
    child.on('error', (error) => { clearTimeout(timer); stopObserving(); reject(error); });
    child.on('close', (code) => { clearTimeout(timer); stopObserving(); resolve({ code, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() }); });
    child.stdin.on('error', () => {});
    if (!keepStdinOpen) child.stdin.end(input);
  });
  return { root, bridge, bindingFile, messages, invoke, execute, env, observation };
}

test('generated script preserves text, rejects invalid input, and leaves no tool history', async (t) => {
  const f = await fixture(t);
  const text = messageBodies[0];
  const sent = await f.execute(['send', '--text', text]);
  assert.equal(sent.code, 0); assert.equal(sent.stdout, 'send_parent: submitted\n'); assert.deepEqual(f.messages, [text]);
  const receipt = f.bridge.acceptInput({ id: id(1), text });
  const received = await f.execute(['receive', '--timeout-ms', '1000']);
  assert.equal(received.code, 0);
  const boundary = /^receive_parent: received\nBEGIN_MESSAGE:([0-9a-f]{8})\n/.exec(received.stdout)?.[1];
  assert.ok(boundary); assert.equal(received.stdout, `receive_parent: received\nBEGIN_MESSAGE:${boundary}\n${text}\nEND_MESSAGE:${boundary}\n`);
  assert.deepEqual(await receipt, { status: 'submitted' });
  for (const args of [['send', '--text', ' '], ['send', '--text', text + 'x'], ['receive', '--timeout-ms', '-1'], ['receive', '--timeout-ms', '1800001'], ['send', '--text', 'x', '--from', 'other']]) {
    const failure = await f.execute(args); assert.equal(failure.code, 2); assert.equal(failure.stdout, ''); assert.match(failure.stderr, /code: /);
  }
  assert.deepEqual(f.messages, [text]);
  assert.deepEqual((await fs.readdir(path.dirname(f.bindingFile))).sort(), ['binding.json']);
});

// Test Value Gate: shape errors must return before stdin, selected files, or
// the private communication tool can be accessed. A held-open pipe must not wait.
test('child send rejects invalid arguments without reading stdin or invoking a tool', async (t) => {
  const observed = [];
  const source = channel('aw.subagent.bridge');
  const listener = (event) => observed.push(event);
  source.subscribe(listener); t.after(() => source.unsubscribe(listener));
  const stdin = { [Symbol.asyncIterator]() { assert.fail('Child send must not read stdin.'); } };
  const binding = path.join(os.tmpdir(), 'unused-aw-child-binding.json');
  for (const args of [
    ['send'], ['send', '--text'], ['send', '--text-file'],
    ['send', '--text', '-'], ['send', '--text-file', '-'],
    ['send', '--text', 'x', '--text-file', 'missing'],
    ['send', '--text-file', 'missing', '--text', 'x'],
    ['send', '--text', 'x', '--text', 'y'],
    ['send', '--text-file', 'missing', '--text-file', 'other'],
    ['send', '--text-file', 'missing', '--timeout-ms', '0'],
    ['send', '--unknown', 'x'], ['receive', '--text', 'x'],
    ['receive', '--text-file', 'missing'], ['receive', '--timeout-ms', '0', '--timeout-ms', '1'],
  ]) {
    let stdout = '', stderr = '';
    const exit = await runMessage(['--bridge', binding, ...args], { stdin, stdout: { write(value) { stdout += value; } }, stderr: { write(value) { stderr += value; } } });
    assert.equal(exit, 2, JSON.stringify(args));
    assert.equal(stdout, ''); assert.match(stderr, /^code: invalidArguments$/m);
  }
  assert.deepEqual(observed, []);
  const f = await fixture(t);
  const failure = await f.execute(['send', '--text', '-'], undefined, { keepStdinOpen: true });
  assert.equal(failure.code, 2); assert.match(failure.stderr, /^code: invalidArguments$/m);
  assert.deepEqual(f.messages, []);
  assert.deepEqual(await fs.readdir(path.dirname(f.bindingFile)), ['binding.json']);
});

// Test Value Gate: the installed command must preserve selected file bytes,
// resolve paths at its caller cwd, and classify content versus I/O failures.
test('child send reads explicit files and rejects invalid files before submitting', async (t) => {
  const f = await fixture(t);
  const text = messageBodies[1];
  assert.ok(Buffer.byteLength(JSON.stringify({ text })) > 65536);
  await fs.writeFile(path.join(f.root, 'message.txt'), text);
  const sent = await f.execute(['send', '--text-file', 'message.txt']);
  assert.equal(sent.code, 0); assert.equal(sent.stdout, 'send_parent: submitted\n');
  await fs.writeFile(path.join(f.root, '-'), '-');
  assert.equal((await f.execute(['send', '--text-file', './-'])).code, 0);
  assert.deepEqual(f.messages, [text, '-']);
  for (const [name, bytes, code] of [
    ['invalid-utf8', Buffer.from([0xc0, 0x80]), 'inputFileInvalid'],
    ['nul', Buffer.from('x\0y'), 'inputFileInvalid'],
    ['blank', Buffer.from(' \r\n'), 'inputFileInvalid'],
    ['large', Buffer.from(messageBodies[0] + 'x'), 'messageTooLarge'],
  ]) {
    await fs.writeFile(path.join(f.root, name), bytes);
    const failure = await f.execute(['send', '--text-file', name]);
    assert.equal(failure.code, 2); assert.match(failure.stderr, new RegExp(`^code: ${code}$`, 'm')); assert.equal(failure.stdout, '');
  }
  const directory = await f.execute(['send', '--text-file', '.']);
  assert.equal(directory.code, 2); assert.match(directory.stderr, /^code: inputFileInvalid$/m);
  if (!windows) {
    await fs.symlink(path.join(f.root, 'message.txt'), path.join(f.root, 'linked'));
    const linked = await f.execute(['send', '--text-file', 'linked']);
    assert.equal(linked.code, 2); assert.match(linked.stderr, /^code: inputFileInvalid$/m);
  }
  const missing = await f.execute(['send', '--text-file', 'missing']);
  assert.equal(missing.code, 1); assert.match(missing.stderr, /^code: inputFileReadFailed$/m);
  assert.deepEqual(f.messages, [text, '-']);
  assert.deepEqual(await fs.readdir(path.dirname(f.bindingFile)), ['binding.json']);
});

test('missing installed toolkit fails bridge setup before communication can be declared ready', async (t) => {
  await assert.rejects(fixture(t, { toolkit: {
    module: path.join(scripts, 'runtime/adapter-channel.mjs'), command: process.execPath,
    messageScript: path.join(scripts, 'does-not-exist.mjs'), mcpScript,
  } }), { code: 'pathMissing' });
});

test('caller and scanner never delete the same response concurrently', async (t) => {
  const f = await fixture(t); const directory = path.dirname(f.bindingFile);
  const unlink = fs.unlink.bind(fs); let deletingResponse = false; let collisions = 0; let failRemoval = false;
  const removalError = Object.assign(new Error('A controlled deletion failed.'), { code: 'EACCES' });
  let releaseScanner; const scannerReleased = new Promise((resolve) => { releaseScanner = resolve; });
  let requestRemoved; const observedScan = new Promise((resolve) => { requestRemoved = resolve; });
  let removedRequest = false;
  const events = channel('aw.subagent.bridge');
  const observed = (event) => { if (event.phase === 'scanCompleted' && removedRequest) requestRemoved(); };
  events.subscribe(observed);
  t.after(() => { releaseScanner(); events.unsubscribe(observed); });
  t.mock.method(fs, 'unlink', async (target) => {
    if (path.dirname(target) !== directory) return unlink(target);
    if (target.endsWith('.request.json')) {
      await unlink(target); removedRequest = true;
      await observedScan;
      return;
    }
    if (!target.endsWith('.response.json')) return unlink(target);
    if (failRemoval) throw removalError;
    const request = target.replace('.response.json', '.request.json');
    const callerOwnsResponse = await fs.lstat(request).then(() => true, () => false);
    if (callerOwnsResponse) return unlink(target);
    if (deletingResponse) {
      collisions++;
      f.observation.note('controlledOverlapFailureInjected', { resourceKind: 'response', osCode: 'EBUSY' });
      throw Object.assign(new Error('A controlled overlapping deletion failed.'), { code: 'EBUSY' });
    }
    deletingResponse = true; requestRemoved();
    await scannerReleased;
    return unlink(target);
  });
  f.observation.note('cleanupInvocation', { index: 0 });
  try { assert.equal((await f.invoke('send', { text: 'cleanup ownership' })).outcome, 'submitted'); }
  finally { releaseScanner(); }
  assert.equal(collisions, 0);
  failRemoval = true;
  f.observation.note('controlledCleanupFailureInjected', { index: 1, resourceKind: 'response', osCode: 'EACCES' });
  await assert.rejects(f.invoke('send', { text: 'report the cleanup error' }), (error) => {
    assert.equal(error.code, 'toolResourceCleanupFailed'); assert.equal(error.resourceKind, 'response');
    assert.equal(error.osCode, 'EACCES'); assert.equal(error.cause, removalError);
    return true;
  });
});

test('single-message byte boundary and queues remain usable beyond 64 inputs and sends', async (t) => {
  const f = channelFixture(t);
  const text = messageBodies[0];
  assert.equal((await f.invoke('send', { text })).outcome, 'submitted');
  const deliveries = [];
  for (let index = 0; index < 80; index++) deliveries.push(f.bridge.acceptInput({ id: id(index), text: index === 0 ? text : 'same text' }));
  assert.equal(f.bridge.hasPendingInput(), true);
  for (let index = 0; index < 80; index++) {
    assert.equal((await f.invoke('send', { text: 'same text' })).outcome, 'submitted', `send index ${index}`);
    const received = await f.invoke('receive', { timeoutMs: 0 });
    assert.equal(received.outcome, 'received', `receive index ${index}`); assert.equal(received.text, index === 0 ? text : 'same text', `text index ${index}`);
  }
  assert.equal((await Promise.all(deliveries)).every((delivery) => delivery.status === 'submitted'), true);
  assert.equal(f.bridge.hasPendingInput(), false); assert.equal(f.messages.length, 81);
  await assert.rejects(f.invoke('send', { text: `${text}x` }), { code: 'messageTooLarge' });
  assert.equal((await f.invoke('receive', { timeoutMs: 0 })).outcome, 'timeout');
});

test('explicit receive and automatic input share allocation without replay', async (t) => {
  const diagnostic = caseDiagnostics(t);
  const automatic = []; let finishSubmission;
  const f = channelFixture(t, { submitInput: (message) => new Promise((resolve) => { automatic.push(message); finishSubmission = resolve; diagnostic.note('automaticSubmissionStarted'); }) });
  diagnostic.note('fixtureReady');
  const first = f.bridge.acceptInput({ id: id(1), text: messageBodies[1] });
  await until(() => automatic.length === 1);
  assert.deepEqual(automatic, [{ id: id(1), text: messageBodies[1] }]);
  assert.equal(f.bridge.hasPendingInput(), true);
  assert.equal((await f.invoke('receive', { timeoutMs: 0 })).outcome, 'timeout');
  const timeoutMs = 1000;
  const responses = new Map();
  const receivers = [0, 1].map((index) => {
    diagnostic.note('receiveInvoked', { index, timeoutMs });
    return f.invoke('receive', { timeoutMs }).then((response) => {
      responses.set(index, response); diagnostic.note('receiveResolved', { index, response });
      return { index, response };
    });
  });
  const duplicate = await Promise.race(receivers);
  assert.equal(duplicate.response.code, 'receiveAlreadyPending', diagnostic.snapshot({ responses: [...responses] }));
  const receivingIndex = 1 - duplicate.index;
  assert.equal(responses.has(receivingIndex), false, diagnostic.snapshot({ responses: [...responses] }));
  const second = f.bridge.acceptInput({ id: id(2), text: messageBodies[0] });
  const received = (await receivers[receivingIndex]).response;
  assert.equal(received.outcome, 'received'); assert.equal(received.text, messageBodies[0]); assert.deepEqual(await second, { status: 'submitted' });
  finishSubmission({ status: 'unknown', code: 'backendUncertain' });
  assert.deepEqual(await first, { status: 'unknown', code: 'backendUncertain' });
  assert.equal(automatic.length, 1); assert.equal(f.bridge.hasPendingInput(), false);
});

test('parent input before receive stays available until the backend can submit immediately', async (t) => {
  let backendReady = false; const automatic = [];
  const f = channelFixture(t, {
    canSubmitInput: () => backendReady,
    submitInput: async (message) => { automatic.push(message); return { status: 'submitted' }; },
  });
  const explicit = f.bridge.acceptInput({ id: id(1), text: 'early parent reply' });
  const received = await f.invoke('receive', { timeoutMs: 200 });
  assert.equal(received.outcome, 'received'); assert.equal(received.text, 'early parent reply');
  assert.deepEqual(await explicit, { status: 'submitted' }); assert.deepEqual(automatic, []);
  const nextTurn = f.bridge.acceptInput({ id: id(2), text: 'next turn input' });
  assert.equal(f.bridge.hasPendingInput(), true);
  backendReady = true; f.bridge.schedule();
  assert.deepEqual(await nextTurn, { status: 'submitted' });
  assert.deepEqual(automatic, [{ id: id(2), text: 'next turn input' }]);
  assert.equal((await f.invoke('receive', { timeoutMs: 0 })).outcome, 'timeout');
  backendReady = false;
  const notAttempted = f.bridge.acceptInput({ id: id(3), text: 'still queued' });
  await f.bridge.close('cancelled');
  assert.equal((await notAttempted).status, 'notSubmitted'); assert.equal(automatic.length, 1);
});

test('invalid backend readiness closes the queue and private bridge resources', async (t) => {
  for (const canSubmitInput of [() => undefined, () => { throw new Error('Backend readiness failed.'); }]) {
    await t.test('readiness failure', async (t) => {
      const f = await fixture(t, { canSubmitInput, submitInput: async () => { assert.fail('No input can be submitted.'); } });
      assert.equal((await f.bridge.acceptInput({ id: id(1), text: 'not submitted' })).status, 'notSubmitted');
      await f.observation.wait('bridgeClosed');
      await assert.rejects(fs.stat(path.dirname(f.bindingFile)), { code: 'ENOENT' });
      assert.equal((await f.invoke('receive', { timeoutMs: 0 })).outcome, 'closed');
    });
  }
});

test('close wakes default receive, cancels submission, resolves queued inputs, and removes resources', async (t) => {
  let observedSignal;
  const automatic = channelFixture(t, { submitInput: (_message, { signal }) => { observedSignal = signal; return new Promise(() => {}); } });
  const pending = automatic.bridge.acceptInput({ id: id(1), text: 'attempted' });
  const queued = automatic.bridge.acceptInput({ id: id(2), text: 'queued' });
  await until(() => observedSignal !== undefined);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const closing = automatic.bridge.close('cancelled');
  assert.equal(observedSignal.aborted, true);
  t.mock.timers.tick(500); await closing; t.mock.timers.reset();
  assert.equal((await pending).status, 'unknown'); assert.equal((await queued).status, 'notSubmitted');
  assert.equal((await automatic.bridge.acceptInput({ id: id(3), text: 'late' })).code, 'runClosed');
  assert.equal(automatic.bridge.hasPendingInput(), false);
  await automatic.bridge.close('cancelled');
  const explicit = await fixture(t);
  const receiving = explicit.invoke('receive');
  await explicit.observation.wait('receiveWaiting');
  await explicit.bridge.close('completed');
  assert.equal((await receiving).outcome, 'closed');
  await assert.rejects(fs.stat(path.dirname(explicit.bindingFile)), { code: 'ENOENT' });
});

test('default receive timeout uses simulated time without waiting ten minutes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = channelFixture(t); let settled = false;
  const receiving = f.invoke('receive').then((response) => { settled = true; return response; });
  t.mock.timers.tick(599999); await Promise.resolve(); assert.equal(settled, false);
  t.mock.timers.tick(1); assert.equal((await receiving).outcome, 'timeout');
  await f.bridge.close('completed');
});

test('fixed explicit deadline wakes receive, while null leaves the bridge open', async (t) => {
  const f = await fixture(t, { deadlineAt: Date.now() + 250 });
  assert.equal((await f.invoke('receive')).outcome, 'closed');
  const open = await fixture(t);
  await pause(40);
  assert.equal((await open.invoke('send', { text: 'still open' })).outcome, 'submitted');
});

test('an abandoned receive releases the shared receiver instead of blocking later tools', async (t) => {
  const f = await fixture(t); const controller = new AbortController();
  const abandoned = f.invoke('receive', { signal: controller.signal });
  const waiting = await f.observation.wait('receiveWaiting');
  controller.abort();
  assert.equal((await abandoned).outcome, 'closed');
  await f.observation.wait('requestHandled', (event) => event.requestId === waiting.requestId);
  assert.equal((await f.invoke('receive', { timeoutMs: 0 })).outcome, 'timeout');
  const delivered = f.bridge.acceptInput({ id: id(1), text: 'next receiver' });
  assert.equal((await f.invoke('receive', { timeoutMs: 1800000 })).text, 'next receiver');
  assert.deepEqual(await delivered, { status: 'submitted' });
});

test('generated MCP process supports concurrent receive/send and rejects extra tool identity', async (t) => {
  const diagnostic = caseDiagnostics(t);
  const f = await fixture(t);
  diagnostic.note('fixtureReady');
  const child = spawn(f.bridge.mcpServer.command, f.bridge.mcpServer.args, { shell: false, cwd: f.root, env: f.env, stdio: ['pipe', 'pipe', 'pipe'] });
  const responses = new Map(); let buffer = ''; let diagnostics = '';
  const responseWindow = windows ? 10000 : 3000;
  const timer = setTimeout(() => { diagnostic.note('mcpWatchdogExpired'); child.kill(); }, windows ? 30000 : 8000);
  t.after(() => { clearTimeout(timer); child.kill(); });
  child.once('exit', (code, signal) => diagnostic.note('mcpExited', { code, signal }));
  child.stderr.setEncoding('utf8'); child.stderr.on('data', (data) => { diagnostics += data; });
  child.stdout.setEncoding('utf8'); child.stdout.on('data', (data) => {
    buffer += data;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) { const response = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); responses.set(response.id, response); diagnostic.note('mcpResponse', { response }); }
  });
  const request = (id, method, params) => { diagnostic.note('mcpRequest', { id, method, tool: params?.name }); return child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); };
  request(1, 'initialize', { protocolVersion: '2025-03-26' }); request(2, 'tools/list', {});
  await until(() => responses.has(1) && responses.has(2), responseWindow);
  assert.equal(responses.get(1).result.protocolVersion, '2025-03-26');
  assert.deepEqual(responses.get(2).result.tools.map((tool) => tool.name), ['send_parent', 'receive_parent']);
  request(3, 'tools/call', { name: 'receive_parent', arguments: {} });
  request(4, 'tools/call', { name: 'send_parent', arguments: { text: messageBodies[0] } });
  try { await until(() => responses.has(4), responseWindow); }
  catch (error) {
    diagnostic.note('sendResponseWaitFailed', { childExitCode: child.exitCode, childSignal: child.signalCode, diagnostics });
    throw new Error(`${error.message}\n${diagnostic.snapshot({ responses: [...responses.values()], messages: f.messages, diagnostics })}`, { cause: error });
  }
  assert.equal(responses.has(3), false); assert.deepEqual(f.messages, [messageBodies[0]]);
  request(5, 'tools/call', { name: 'send_parent', arguments: { text: 'wrong', from: 'other' } });
  await until(() => responses.has(5), responseWindow); assert.equal(responses.get(5).result.isError, true); assert.equal(f.messages.length, 1);
  const delivered = f.bridge.acceptInput({ id: id(1), text: messageBodies[1] });
  await until(() => responses.has(3), responseWindow);
  const received = responses.get(3).result.content[0].text;
  const boundary = /^receive_parent: received\nBEGIN_MESSAGE:([0-9a-f]{8})\n/.exec(received)?.[1];
  assert.ok(boundary); assert.equal(received, `receive_parent: received\nBEGIN_MESSAGE:${boundary}\n${messageBodies[1]}\nEND_MESSAGE:${boundary}\n`);
  assert.deepEqual(await delivered, { status: 'submitted' });
  request(7, 'tools/call', { name: 'send_parent', arguments: { text: messageBodies[1] } });
  await until(() => responses.has(7), responseWindow);
  assert.equal(responses.get(7).result.isError, undefined);
  assert.deepEqual(f.messages, messageBodies);
  request(8, 'tools/call', { name: 'send_parent', arguments: { text: messageBodies[0] + 'x' } });
  await until(() => responses.has(8), responseWindow);
  assert.equal(responses.get(8).result.isError, true);
  assert.match(responses.get(8).result.content[0].text, /^code: messageTooLarge$/m);
  assert.deepEqual(f.messages, messageBodies);
  request(6, 'tools/call', { name: 'receive_parent', arguments: {} });
  const exited = once(child, 'exit'); child.stdin.end();
  assert.deepEqual(await exited, [0, null]);
  assert.equal(diagnostics, '');
});

// Test Value Gate: removed command flags must fail before the MCP server reads
// JSON input or starts a communication operation.
test('child MCP rejects the removed send-only flag before reading input', async () => {
  const stdin = { [Symbol.asyncIterator]() { assert.fail('Invalid MCP arguments must not read input.'); } };
  await assert.rejects(runMessageMcp(['--bridge', path.join(os.tmpdir(), 'unused-aw-child-binding.json'), '--send-only'], { stdin }), { code: 'invalidArguments' });
});
